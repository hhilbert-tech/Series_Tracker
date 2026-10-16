from datetime import date

import pytest

from tests.fakes import FakeClient
from tracker import db

TODAY = date(2026, 10, 16)


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    db.init_db(c)
    yield c
    c.close()


@pytest.fixture
def client():
    return FakeClient()
