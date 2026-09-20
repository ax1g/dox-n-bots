from fastapi.testclient import TestClient

from main import Room, Player, app, completed_boxes, edge_id, legal_edge, rooms


def room():
    return Room("ABC123", 3, 3, {"p1": Player("Alpha", "one"), "p2": Player("Bravo", "two")})


def test_edge_validation_rejects_diagonals_and_out_of_range():
    game = room()
    assert legal_edge(game, 0, 1)
    assert not legal_edge(game, 0, 4)
    assert not legal_edge(game, 0, 9)


def test_completing_box_keeps_the_turn():
    game = room()
    game.edges.update({edge_id(0, 1), edge_id(0, 3), edge_id(1, 4), edge_id(3, 4)})
    assert completed_boxes(game, 3, 4) == ["0:0"]


def test_room_create_join_and_full_room_rejection():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post("/api/rooms", json={"name": "Alpha", "cols": 5, "rows": 5})
        assert created.status_code == 201
        data = created.json()
        joined = client.post(f"/api/rooms/{data['room_id']}/join", json={"name": "Bravo"})
        assert joined.status_code == 200
        full = client.post(f"/api/rooms/{data['room_id']}/join", json={"name": "Charlie"})
        assert full.status_code == 409


def test_websocket_rejects_out_of_turn_move():
    rooms.clear()
    with TestClient(app) as client:
        created = client.post("/api/rooms", json={"name": "Alpha", "cols": 3, "rows": 3}).json()
        joined = client.post(f"/api/rooms/{created['room_id']}/join", json={"name": "Bravo"}).json()
        with client.websocket_connect(f"/ws/rooms/{created['room_id']}?token={created['token']}") as first:
            first.receive_json()
            with client.websocket_connect(f"/ws/rooms/{created['room_id']}?token={joined['token']}") as second:
                second.receive_json()
                second.send_json({"type": "move", "edge": [0, 1]})
                assert second.receive_json()["type"] == "error"
