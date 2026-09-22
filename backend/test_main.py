from fastapi.testclient import TestClient
from main import Player, Room, app, completed_boxes, edge_id, legal_edge, rooms
from migrate import migrate


def test_migrations_build_expected_schema_and_rerun_safely(tmp_path):
    import sqlite3

    db = sqlite3.connect(tmp_path / "fresh.db")
    assert migrate(db) == [1, 2, 3]
    assert migrate(db) == []
    columns = [row[1] for row in db.execute("PRAGMA table_info(scores)")]
    assert columns == [
        "name",
        "score",
        "width",
        "height",
        "created_at",
        "opponent",
        "winner",
        "margin",
        "mode",
        "detail",
        "match_id",
    ]
    versions = [
        row[0] for row in db.execute("SELECT version FROM schema_version ORDER BY version")
    ]
    assert versions == [1, 2, 3]
    db.close()


def room():
    return Room(
        "ABC123", 3, 3, {"p1": Player("Alpha", "one"), "p2": Player("Bravo", "two")}
    )


def test_edge_validation_rejects_diagonals_and_out_of_range():
    game = room()
    assert legal_edge(game, 0, 1)
    assert not legal_edge(game, 0, 4)
    assert not legal_edge(game, 0, 9)


def test_completing_box_keeps_the_turn():
    game = room()
    game.edges.update({edge_id(0, 1), edge_id(0, 3), edge_id(1, 4), edge_id(3, 4)})
    assert completed_boxes(game, 3, 4) == ["0:0"]


def test_leaderboard_lists_each_match_once():
    rooms.clear()
    with TestClient(app) as client:
        for name, score, winner in (("Alpha", 8, "Alpha"), ("Bravo", 3, "Alpha")):
            response = client.post(
                "/api/leaderboard",
                json={
                    "name": name,
                    "score": score,
                    "width": 5,
                    "height": 5,
                    "opponent": "Bravo" if name == "Alpha" else "Alpha",
                    "winner": winner,
                    "margin": 5,
                    "mode": "ONLINE",
                    "detail": "FRIEND",
                    "match_id": "ROOM42",
                },
            )
            assert response.status_code == 201
        rows = client.get("/api/leaderboard").json()
        match_rows = [row for row in rows if row["match_id"] == "ROOM42"]
        assert len(match_rows) == 1
        assert match_rows[0]["name"] == "Alpha"


def test_room_create_join_and_full_room_rejection():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post(
            "/api/rooms", json={"name": "Alpha", "cols": 5, "rows": 5}
        )
        assert created.status_code == 201
        data = created.json()
        joined = client.post(
            f"/api/rooms/{data['room_id']}/join", json={"name": "Bravo"}
        )
        assert joined.status_code == 200
        retake = client.post(
            f"/api/rooms/{data['room_id']}/join", json={"name": "Charlie"}
        )
        assert retake.status_code == 200
        assert retake.json()["seat"] == "p2"
        with client.websocket_connect(
            f"/ws/rooms/{data['room_id']}?token={data['token']}"
        ):
            with client.websocket_connect(
                f"/ws/rooms/{data['room_id']}?token={retake.json()['token']}"
            ):
                full = client.post(
                    f"/api/rooms/{data['room_id']}/join", json={"name": "Delta"}
                )
                assert full.status_code == 409


def test_websocket_answers_ping_without_error():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post(
            "/api/rooms", json={"name": "Alpha", "cols": 3, "rows": 3}
        ).json()
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            first.receive_json()
            first.send_json({"type": "ping"})
            assert first.receive_json() == {"type": "pong"}
            first.send_json({"type": "pong"})


def test_websocket_reconnect_with_same_token_resumes_match():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post(
            "/api/rooms", json={"name": "Alpha", "cols": 3, "rows": 3}
        ).json()
        joined = client.post(
            f"/api/rooms/{created['room_id']}/join", json={"name": "Bravo"}
        ).json()
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            first.receive_json()
            with client.websocket_connect(
                f"/ws/rooms/{created['room_id']}?token={joined['token']}"
            ):
                pass
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            state = first.receive_json()
            assert state["type"] == "state"
            assert state["players"]["p1"]["connected"] is True


def test_takeover_join_fills_disconnected_seat_and_rejects_full_room():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post(
            "/api/rooms", json={"name": "Alpha", "cols": 3, "rows": 3}
        ).json()
        joined = client.post(
            f"/api/rooms/{created['room_id']}/join", json={"name": "Bravo"}
        ).json()
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            first.receive_json()
            with client.websocket_connect(
                f"/ws/rooms/{created['room_id']}?token={joined['token']}"
            ):
                pass
        retake = client.post(
            f"/api/rooms/{created['room_id']}/join", json={"name": "Charlie"}
        )
        assert retake.status_code == 200
        assert retake.json()["seat"] == "p2"
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            first.receive_json()
            with client.websocket_connect(
                f"/ws/rooms/{retake.json()['room_id']}?token={retake.json()['token']}"
            ) as third:
                third.receive_json()
                full = client.post(
                    f"/api/rooms/{created['room_id']}/join", json={"name": "Delta"}
                )
                assert full.status_code == 409


def test_websocket_rejects_out_of_turn_move():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post(
            "/api/rooms", json={"name": "Alpha", "cols": 3, "rows": 3}
        ).json()
        joined = client.post(
            f"/api/rooms/{created['room_id']}/join", json={"name": "Bravo"}
        ).json()
        with client.websocket_connect(
            f"/ws/rooms/{created['room_id']}?token={created['token']}"
        ) as first:
            first.receive_json()
            with client.websocket_connect(
                f"/ws/rooms/{created['room_id']}?token={joined['token']}"
            ) as second:
                second.receive_json()
                second.send_json({"type": "move", "edge": [0, 1]})
                assert second.receive_json()["type"] == "error"
