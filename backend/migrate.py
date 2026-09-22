"""Ordered SQL migrations for the leaderboard database.

Migration files live in backend/migrations/ and are named
<version>_<description>.sql, for example 002_online_fields.sql.
Each file runs once, in version order, inside a transaction, and the
applied versions are recorded in the schema_version table. Rerunning
is safe: already-applied versions are skipped.
"""

import sqlite3
from pathlib import Path

MIGRATIONS = Path(__file__).with_name("migrations")


def pending(db: sqlite3.Connection) -> list[Path]:
    db.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)"
    )
    applied = {row[0] for row in db.execute("SELECT version FROM schema_version")}
    files = sorted(MIGRATIONS.glob("*.sql"), key=lambda path: path.name)
    return [
        path
        for path in files
        if int(path.stem.split("_")[0]) not in applied
    ]


def migrate(db: sqlite3.Connection) -> list[int]:
    done = []
    for path in pending(db):
        version = int(path.stem.split("_")[0])
        with db:
            for statement in path.read_text().split(";"):
                statement = statement.strip()
                if not statement:
                    continue
                try:
                    db.execute(statement)
                except sqlite3.OperationalError as error:
                    # Databases created before versioning already carry
                    # these columns; only ignore that specific case.
                    if "duplicate column name" not in str(error):
                        raise
            db.execute(
                "INSERT INTO schema_version (version) VALUES (?)", (version,)
            )
        done.append(version)
    return done
