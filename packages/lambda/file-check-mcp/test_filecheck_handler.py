"""Handler tests with a fake DynamoDB table (no AWS calls)."""

import json
import os
import sys
from decimal import Decimal
from types import SimpleNamespace

os.environ['BACKEND_TABLE_NAME'] = 'test-table'
os.environ['AWS_DEFAULT_REGION'] = 'ap-south-1'
os.environ.setdefault('AWS_REGION', 'ap-south-1')
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'
os.environ['AWS_SESSION_TOKEN'] = 'testing'
os.environ.pop('DEFAULT_CHECKLIST_ID', None)
os.environ.pop('CHECKLISTS_PATH', None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import index  # noqa: E402
from test_filecheck_engine import doc_items, rahul, sneha  # noqa: E402


def _to_ddb(value):
    """Mimic boto3's resource layer: numbers come back as Decimal."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_ddb(v) for v in value]
    return value


class FakeTable:
    """Returns the project items in two pages and records each query."""

    def __init__(self, items):
        self.items = items
        self.calls = []

    def query(self, **kwargs):
        self.calls.append(kwargs)
        half = len(self.items) // 2
        if 'ExclusiveStartKey' not in kwargs:
            return {'Items': self.items[:half], 'LastEvaluatedKey': {'PK': 'x', 'SK': 'y'}}
        assert kwargs['ExclusiveStartKey'] == {'PK': 'x', 'SK': 'y'}
        return {'Items': self.items[half:]}


def _items(facts, pid='p1'):
    out = [{'PK': f'PROJ#{pid}', 'SK': 'META', 'data': {'name': 'Demo'}}]
    for d in doc_items(facts):
        out.append({'PK': f'PROJ#{pid}', 'SK': f"DOC#{d['document_id']}",
                    'data': _to_ddb(d)})
    for f in facts:
        out.append({'PK': f'PROJ#{pid}', 'SK': f"FACTS#{f['document_id']}",
                    'data': _to_ddb(f), 'created_at': 'x', 'updated_at': 'x'})
    return out


def _ctx(tool):
    return SimpleNamespace(
        client_context=SimpleNamespace(custom={'bedrockAgentCoreToolName': tool})
    )


RUN = _ctx('filecheck___run_file_check')


@pytest.fixture
def table(monkeypatch):
    t = FakeTable(_items(rahul() + sneha()))
    monkeypatch.setattr(index, '_table', t)
    return t


def test_run_file_check_verdict_and_pagination(table):
    res = index.handler({'project_id': 'p1', 'user_id': 'u-123'}, RUN)
    assert 'error' not in res
    assert len(table.calls) == 2  # two pages
    cond = table.calls[0]['KeyConditionExpression']
    assert cond.get_expression()['values'][1] == 'PROJ#p1'
    assert 'IndexName' not in table.calls[0]  # base table only
    assert res['project_id'] == 'p1'
    assert res['overall_verdict'] == 'NOT READY'
    verdicts = {a['applicant']: a['verdict'] for a in res['applicants']}
    assert verdicts == {
        'Rahul Vijay Deshmukh': 'READY',
        'Sneha Anil Kulkarni': 'NOT READY',
    }
    json.dumps(res, ensure_ascii=False)


def test_decimal_conversion(table):
    res = index.handler({'project_id': 'p1'}, RUN)
    rahul_res = next(a for a in res['applicants'] if a['pan'] == 'BQXPD4821K')
    income = rahul_res['income']
    assert income['declared_net'] == 82500
    assert type(income['declared_net']) is int
    assert type(income['bank_credits'][0]['amount']) is int

    docs, facts = index.load_project_items(table, 'p1')
    assert len(docs) == 12 and len(facts) == 12
    assert facts[0]['grounding']['text_chars'] == 1200
    assert not any(isinstance(v, Decimal) for v in facts[0]['fields'].values())
    assert index._from_decimal(Decimal('0.5')) == 0.5


def test_checklist_and_filters(table):
    res = index.handler(
        {'project_id': 'p1', 'checklist_id': 'salaried_personal_loan',
         'applicant': 'BQXPD4821K', 'reference_month': '2026-08'},
        RUN,
    )
    assert [a['applicant'] for a in res['applicants']] == ['Rahul Vijay Deshmukh']
    assert res['overall_verdict'] == 'READY'


def test_missing_project_id(table):
    assert index.handler({}, RUN) == {'error': 'project_id is required'}
    assert index.handler({'project_id': '  '}, RUN) == {
        'error': 'project_id is required'
    }
    assert 'error' in index.handler({'project_id': 42}, RUN)
    assert table.calls == []


def test_unknown_checklist(table):
    res = index.handler({'project_id': 'p1', 'checklist_id': 'home_loan'}, RUN)
    assert res['error'] == 'Unknown checklist_id: home_loan'
    assert res['available'][0] == 'salaried_personal_loan'
    assert 'ss_pl_sal' in res['available']
    assert table.calls == []


@pytest.mark.parametrize('month', ['2026-8', 'Aug 2026', '2026-13', '2026-00'])
def test_bad_reference_month(table, month):
    res = index.handler({'project_id': 'p1', 'reference_month': month}, RUN)
    assert res['error'].startswith('reference_month must be YYYY-MM')


def test_unknown_tool(table):
    res = index.handler({'project_id': 'p1'}, _ctx('filecheck___delete_all'))
    assert res == {'error': 'Unknown tool: filecheck___delete_all'}
    assert index.handler({}, SimpleNamespace(client_context=None)) == {
        'error': 'Unknown tool: '
    }


def test_list_checklists(table):
    res = index.handler({'project_id': 'p1'}, _ctx('filecheck___list_checklists'))
    assert res['default_checklist'] == 'salaried_personal_loan'
    ids = [c['id'] for c in res['checklists']]
    # Default first, then the bundled ready-made brand rule sets
    assert ids[0] == 'salaried_personal_loan'
    assert {'ss_pl_sal', 'ls_pl_sal'} <= set(ids)
    assert table.calls == []


def test_unexpected_error_is_reported_without_details(monkeypatch, capsys):
    class Boom:
        def query(self, **kwargs):
            raise RuntimeError('secret BQXPD4821K')

    monkeypatch.setattr(index, '_table', Boom())
    res = index.handler({'project_id': 'p1'}, RUN)
    assert res == {'error': 'file check failed: RuntimeError'}
    out = capsys.readouterr().out
    assert 'RuntimeError' in out and 'BQXPD4821K' not in out


def test_logs_never_contain_facts(table, capsys):
    index.handler({'project_id': 'p1'}, RUN)
    out = capsys.readouterr().out
    for secret in ('BQXPD4821K', 'Rahul', '82500', 'Konkan'):
        assert secret not in out


def test_default_checklist_env_override(monkeypatch, tmp_path, table):
    cat = json.loads(open(index.engine.DEFAULT_CATALOG_PATH).read())
    alt = json.loads(json.dumps(cat['checklists'][0]))
    alt['id'] = 'pl_two_slips'
    alt['name'] = 'PL - two slips'
    alt['items'][2]['rule']['months'] = 2
    cat['checklists'].append(alt)
    path = tmp_path / 'checklists.json'
    path.write_text(json.dumps(cat))
    monkeypatch.setattr(index, 'CHECKLISTS_PATH', str(path))
    monkeypatch.setattr(index, 'DEFAULT_CHECKLIST_ID', 'pl_two_slips')
    monkeypatch.setattr(index, '_catalog', None)
    listed = index.handler({}, _ctx('filecheck___list_checklists'))
    assert listed['default_checklist'] == 'pl_two_slips'
    res = index.handler({'project_id': 'p1', 'applicant': 'CKRPK7314M'}, RUN)
    assert res['checklist']['id'] == 'pl_two_slips'
