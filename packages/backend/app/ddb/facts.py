from app.ddb.client import get_table
from app.ddb.models import DdbKey


def make_facts_key(project_id: str, document_id: str) -> DdbKey:
    """Key of the per-document facts item (written by the document-facts Lambda)."""
    return {"PK": f"PROJ#{project_id}", "SK": f"FACTS#{document_id}"}


def delete_facts_item(project_id: str, document_id: str) -> None:
    table = get_table()
    table.delete_item(Key=make_facts_key(project_id, document_id))
