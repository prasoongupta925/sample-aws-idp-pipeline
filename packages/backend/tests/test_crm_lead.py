"""CRM lead id of a project (app/routers/projects.py): set on create / update, cleared with "",
validated, and unique across projects. DynamoDB is an in-memory fake of the project items."""

import copy
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.ddb.projects import query_projects
from app.main import app
from app.routers.projects import find_project_by_lead

client = TestClient(app)


class FakeProjectsTable:
    def __init__(self):
        self.items: dict[tuple[str, str], dict] = {}

    def put_item(self, Item):
        self.items[(Item["PK"], Item["SK"])] = copy.deepcopy(Item)

    def get_item(self, Key, **_):
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames=None, **_):
        item = self.items[(Key["PK"], Key["SK"])]
        if ":data" in ExpressionAttributeValues:
            item["data"] = copy.deepcopy(ExpressionAttributeValues[":data"])
        item["updated_at"] = ExpressionAttributeValues[":updated_at"]

    def query(self, IndexName=None, **_):
        assert IndexName == "GSI1"
        items = [i for i in self.items.values() if i.get("GSI1PK") == "PROJECTS"]
        return {"Items": copy.deepcopy(sorted(items, key=lambda i: i["GSI1SK"], reverse=True))}


@pytest.fixture
def table():
    fake = FakeProjectsTable()
    with patch("app.ddb.projects.get_table", return_value=fake):
        yield fake


def create(name="Asha Verma", **extra):
    return client.post("/projects", json={"name": name, **extra})


def test_create_with_lead_id_returns_and_stores_it(table):
    response = create(crm_lead_id="SD-LEAD-0042")
    assert response.status_code == 200
    body = response.json()
    assert body["crm_lead_id"] == "SD-LEAD-0042"
    stored = next(iter(table.items.values()))
    assert stored["data"]["crm_lead_id"] == "SD-LEAD-0042"
    assert client.get(f"/projects/{body['project_id']}").json()["crm_lead_id"] == "SD-LEAD-0042"
    assert client.get("/projects").json()[0]["crm_lead_id"] == "SD-LEAD-0042"


def test_create_without_lead_id_has_none(table):
    assert create().json()["crm_lead_id"] is None


@pytest.mark.parametrize("lead", ["", "has space", "x" * 65, "semi;colon", "ünï"])
def test_bad_lead_ids_are_refused(table, lead):
    assert create(crm_lead_id=lead).status_code == 422


def test_update_sets_keeps_and_clears_the_lead_id(table):
    project_id = create().json()["project_id"]
    url = f"/projects/{project_id}"
    assert client.put(url, json={"crm_lead_id": "L-1"}).json()["crm_lead_id"] == "L-1"
    # Absent or null keeps it.
    assert client.put(url, json={"name": "Asha Verma (renamed)"}).json()["crm_lead_id"] == "L-1"
    assert client.put(url, json={"crm_lead_id": None}).json()["crm_lead_id"] == "L-1"
    # "" removes it.
    assert client.put(url, json={"crm_lead_id": ""}).json()["crm_lead_id"] is None
    assert client.put(url, json={"crm_lead_id": "bad id"}).status_code == 422


def test_a_lead_links_to_one_project_only(table):
    first = create(crm_lead_id="L-9").json()["project_id"]
    second = create(name="Rohan Iyer").json()["project_id"]

    response = create(name="Another", crm_lead_id="L-9")
    assert response.status_code == 409
    assert "L-9" in response.json()["detail"]
    assert client.put(f"/projects/{second}", json={"crm_lead_id": "L-9"}).status_code == 409
    # Saving the same project with its own lead id is fine.
    assert client.put(f"/projects/{first}", json={"crm_lead_id": "L-9"}).status_code == 200


def test_find_project_by_lead_picks_the_latest(table):
    create(crm_lead_id="L-1")
    projects = query_projects()
    found = find_project_by_lead(projects, "L-1")
    assert found is not None and found.data.crm_lead_id == "L-1"
    assert find_project_by_lead(projects, "L-1", exclude=found.data.project_id) is None
    assert find_project_by_lead(projects, "L-2") is None
