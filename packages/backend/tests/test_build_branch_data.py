"""Tests for scripts/build_branch_data.py on small synthetic inputs (no download).

The post offices and branches below are made up, placed around Vasai with one wrong point,
one written in degrees-minutes-seconds, one without a point, points that offices of three
pincodes share (a placeholder far off, and a town's point) and two offices far apart; the
output must be what app/branches.py reads.
"""

import csv
import importlib.util
import io
import json
import shutil
from pathlib import Path

import pytest

from app import branches

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_branch_data.py"
_spec = importlib.util.spec_from_file_location("build_branch_data", SCRIPT)
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

OFFICE_COLUMNS = ["OfficeName", "Pincode", "OfficeType", "Delivery", "District", "StateName", "Latitude", "Longitude"]
IFSC_COLUMNS = ["BANK", "IFSC", "BRANCH", "CENTRE", "DISTRICT", "STATE", "ADDRESS", "CITY"]


def office(name, pincode, kind, lat, lon, district="PALGHAR", state="MAHARASHTRA", delivery="Delivery"):
    return dict(zip(OFFICE_COLUMNS, [name, pincode, kind, delivery, district, state, lat, lon], strict=True))


OFFICES = [
    office("Bassein H.O", "401201", "HO", "19.3677", "72.7972"),
    office("Example Pada B.O", "401201", "BO", "19.3601", "72.8102"),
    office("Bassein Road S.O", "401202", "PO", "19.3817", "72.8301"),
    # A copy of a far office's point: ignored.
    office("Example Wadi B.O", "401202", "BO", "28.6205", "77.2129"),
    # 19 deg 22' 48", 72 deg 49' 48" written as decimals: read as degrees-minutes-seconds.
    office("Example Gaon S.O", "401203", "PO", "19.2248", "72.4948"),
    # No point at all: its district's centre, approximate.
    office("Example Nagar B.O", "401204", "BO", "NA", "NA"),
    office("Example Naka B.O", "401205", "BO", "19.4091", "72.8506", district="THANE"),
    office("Example Kopar B.O", "401205", "BO", "19.4102", "72.8455", district="THANE"),
    office("Example Pali S.O", "401205", "PO", "19.4120", "72.8480", delivery="Non Delivery"),
    office("Example Virar S.O", "401303", "PO", "19.4573", "72.8111"),
    office("Example Tal B.O", "401303", "BO", "19.4650", "72.8200"),
    office("New Delhi G.P.O.", "110001", "HO", "28.6205", "77.2129", district="NEW DELHI", state="DELHI"),
    office("Not A Pincode B.O", "99999", "BO", "19.0", "72.8"),
    # A placeholder that the offices of three pincodes share, 65 km off: nobody's own point.
    office("Example Ghat S.O", "401206", "PO", "19.0000000", "73.3000000"),
    office("Example Kot S.O", "401207", "PO", "19.3950", "72.8150"),
    office("Example Kot B.O", "401207", "BO", "19.0000000", "73.3000000"),
    office("Example Dongar B.O", "401209", "BO", "19.0000000", "73.3000000"),
    # A town's point copied to the offices of three pincodes without a point of their own.
    office("Example Agashi S.O", "401301", "PO", "19.4300000", "72.8200000"),
    office("Example Arnala B.O", "401302", "BO", "19.4300000", "72.8200000"),
    office("Example Bolinj B.O", "401304", "BO", "19.4300000", "72.8200000"),
    # A sub office and a branch office 20 km apart: the sub office's town, not a point between.
    office("Example Fort S.O", "401210", "PO", "19.3300", "72.8150"),
    office("Example Hill B.O", "401210", "BO", "19.5000", "72.9500"),
]


def ifsc_row(bank, ifsc, branch, address, centre="VASAI", district="THANE", city="VASAI"):
    return dict(zip(IFSC_COLUMNS, [bank, ifsc, branch, centre, district, "MAHARASHTRA", address, city], strict=True))


IFSC_ROWS = [
    ifsc_row("HDFC Bank", "HDFC0000001", "VASAI WEST", "SHOP 1, STATION ROAD, VASAI WEST, PALGHAR 401 202"),
    ifsc_row("HDFC Bank", "HDFC0000001", "VASAI WEST", "SHOP 1, STATION ROAD, VASAI WEST, PALGHAR 401 202"),
    ifsc_row("HDFC Bank", "HDFC0CEXAMP", "EXAMPLE CO-OP BANK", "VASAI 401202"),
    ifsc_row("HDFC Bank", "HDFC0000002", "CREDIT CARDS OPERATIONS", "MIDC, VASAI 401208"),
    ifsc_row("HDFC Bank", "HDFC0000003", "VIRAR", "NEAR STATION, VIRAR", centre="VIRAR"),
    ifsc_row("ICICI Bank", "ICIC0000001", "MUMBAI-VASAI ROAD", "PLOT 5, VASAI 401201, NEAR 401303 BUS STOP"),
    ifsc_row("ICICI Bank", "ICIC0000002", "EXAMPLE PADA", "BUILDING 2, 401201 TEL 999999", centre="EXAMPLE PADA"),
    ifsc_row("Axis Bank", "UTIB0000001", "VIRAR EAST", "VIRAR 401303, HEAD OFFICE NEW DELHI 110001", centre="X"),
    ifsc_row("Other Bank", "OTHR0000001", "VASAI", "VASAI 401202"),
]


@pytest.fixture(scope="module")
def directory():
    out, located = build.build_directory(OFFICES)
    return out, located


def place(out: dict, pincode: str) -> tuple:
    office_name, district, lat, lon, approx = out["pincodes"][pincode]
    name, state = out["districts"][district]
    return office_name, name, out["states"][state], lat, lon, approx


class TestHelpers:
    @pytest.mark.parametrize(
        ("raw", "shown"),
        [
            ("MUMBAI - VASAI EAST", "Mumbai - Vasai East"),
            ("MIDC ANDHERI", "MIDC Andheri"),
            ("BANK OF BARODA", "Bank of Baroda"),
            ("THE  MALL   ROAD", "The Mall Road"),
            ("D'SOUZA NAGAR", "D'souza Nagar"),
        ],
    )
    def test_display_case(self, raw, shown):
        assert build.display_case(raw) == shown

    def test_state_names_of_both_lists_compare_equal(self):
        assert build.state_key("Orissa") == build.state_key("ODISHA")
        assert build.state_key("The Dadra & Nagar Haveli") == build.state_key("DAMAN AND DIU")

    @pytest.mark.parametrize(
        ("text", "degrees"),
        [("22.3434", 22 + 34 / 60 + 34 / 3600), ("19.38", 19 + 38 / 60), ("72.8301", None), ("19.123456", None)],
    )
    def test_a_decimal_read_as_degrees_minutes_seconds(self, text, degrees):
        assert build._dms(text) == (pytest.approx(degrees) if degrees else None)

    def test_an_office_point_and_its_other_reading(self):
        assert build._readings({"Latitude": "19.3817", "Longitude": "72.8301"}) == [(19.3817, 72.8301)]
        both = build._readings({"Latitude": "19.2248", "Longitude": "72.4948"})
        assert both[0] == (19.2248, 72.4948)
        assert both[1] == (pytest.approx(19.38), pytest.approx(72.83))
        assert build._readings({"Latitude": "NA", "Longitude": ""}) == []
        assert build._readings({"Latitude": "51.5", "Longitude": "-0.12"}) == []

    @pytest.mark.parametrize(
        ("raw", "name"),
        [
            ("Bassein Road S.O", "Bassein Road"),
            ("Azad Nagar S.O (Mumbai)", "Azad Nagar (Mumbai)"),
            ("Vasai H.O", "Vasai"),
        ],
    )
    def test_office_names_lose_their_type(self, raw, name):
        assert build.office_name(raw) == name


class TestDirectory:
    def test_each_pincode_gets_one_place(self, directory):
        out, _ = directory
        assert sorted(out["pincodes"]) == [
            "110001",
            "401201",
            "401202",
            "401203",
            "401204",
            "401205",
            "401206",
            "401207",
            "401209",
            "401210",
            "401301",
            "401302",
            "401303",
            "401304",
        ]
        assert out["columns"] == ["office", "district", "lat", "lon", "approx"]
        assert place(out, "401201")[:3] == ("Bassein", "Palghar", "Maharashtra")
        assert place(out, "110001")[:3] == ("New Delhi G.P.O.", "New Delhi", "Delhi")

    def test_a_far_copied_point_is_ignored(self, directory):
        out, _ = directory
        assert place(out, "401202") == ("Bassein Road", "Palghar", "Maharashtra", 19.3817, 72.8301, 0)

    def test_degrees_minutes_seconds_are_read_as_such_near_the_neighbours(self, directory):
        out, _ = directory
        assert place(out, "401203")[3:] == (19.38, 72.83, 0)

    def test_a_pincode_without_a_point_takes_its_districts_centre(self, directory):
        out, located = directory
        office_name, district, _, lat, lon, approx = place(out, "401204")
        assert (office_name, district, approx) == ("Example Nagar", "Palghar", 1)
        assert 19.3 < lat < 19.5 and 72.7 < lon < 72.9
        assert located["401204"][0] == "MAHARASHTRA"

    def test_the_district_most_offices_name_and_the_delivery_office(self, directory):
        out, _ = directory
        office_name, district, *_ = place(out, "401205")
        # Two of three offices say Thane; the delivery offices come before the non-delivery one.
        assert district == "Thane"
        assert office_name == "Example Kopar"

    def test_the_town_is_where_the_head_and_sub_offices_are(self, directory):
        out, _ = directory
        # 401303: the sub office's point, not the median of the sub and branch offices.
        assert place(out, "401303")[3:] == (19.4573, 72.8111, 0)

    def test_a_point_that_three_pincodes_share_is_nobodys_own(self, directory):
        out, _ = directory
        # With a point of its own, that one; with only the placeholder, the district's centre.
        assert place(out, "401207")[3:] == (19.395, 72.815, 0)
        district_centre = place(out, "401204")[3:5]
        for pincode in ("401206", "401209"):
            assert place(out, pincode)[3:] == (*district_centre, 1)

    def test_a_shared_point_near_the_neighbours_is_used_as_approximate(self, directory):
        out, _ = directory
        for pincode in ("401301", "401302", "401304"):
            assert place(out, pincode)[3:] == (19.43, 72.82, 1)

    def test_offices_far_apart_give_the_sub_offices_town(self, directory):
        out, _ = directory
        assert place(out, "401210")[3:] == (19.33, 72.815, 0)

    def test_app_branches_reads_it(self, directory):
        out, _ = directory
        reader = branches.Directory(out)
        assert len(reader) == 14
        assert reader.place("401202").office == "Bassein Road"
        assert reader.place("401204").approximate is True


class TestBankBranches:
    def test_keeps_each_banks_own_placed_branches(self, directory):
        _, located = directory
        out = build.build_branches(IFSC_ROWS, located)
        assert out["columns"] == ["ifsc", "name", "address", "city", "pincode"]
        hdfc = out["lenders"]["hdfc_bank"]
        assert (hdfc["name"], hdfc["ifsc_prefix"]) == ("HDFC Bank", "HDFC")
        # The sub-member code, the back-office unit, the branch without a pincode and the copy are left out.
        assert hdfc["branches"] == [
            ["HDFC0000001", "Vasai West", "Shop 1, Station Road, Vasai West, Palghar 401 202", "Vasai", "401202"]
        ]

    def test_the_pincode_is_the_last_known_one_in_the_branchs_state(self, directory):
        _, located = directory
        out = build.build_branches(IFSC_ROWS, located)
        icici = {row[0]: row for row in out["lenders"]["icici_bank"]["branches"]}
        assert icici["ICIC0000001"][4] == "401303"
        assert icici["ICIC0000002"][4] == "401201"  # 999999 is no pincode
        axis = out["lenders"]["axis_bank"]["branches"]
        # 110001 is later but in Delhi; the branch is in Maharashtra.
        assert [(row[0], row[4]) for row in axis] == [("UTIB0000001", "401303")]

    def test_the_city_is_the_one_the_address_confirms(self, directory):
        _, located = directory
        out = build.build_branches(IFSC_ROWS, located)
        cities = {row[0]: row[3] for lender in out["lenders"].values() for row in lender["branches"]}
        assert cities["ICIC0000002"] == "Example Pada"
        # Centre X, district Thane and city Vasai are not in the address: the pincode's district.
        assert cities["UTIB0000001"] == "Palghar"

    def test_branches_are_sorted_by_pincode_then_name(self, directory):
        _, located = directory
        out = build.build_branches(IFSC_ROWS, located)
        rows = out["lenders"]["icici_bank"]["branches"]
        assert [row[4] for row in rows] == sorted(row[4] for row in rows)


def _csv(path: Path, columns: list[str], rows: list[dict]) -> Path:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)
    path.write_text(buffer.getvalue(), encoding="utf-8")
    return path


@pytest.fixture
def built(tmp_path, monkeypatch):
    """The script run on the synthetic CSVs into tmp_path, which app/branches.py then reads."""
    monkeypatch.setattr(build, "OUT_DIR", tmp_path / "out")
    pincode_csv = _csv(tmp_path / "pincode.csv", OFFICE_COLUMNS, OFFICES)
    ifsc_csv = _csv(tmp_path / "IFSC.csv", IFSC_COLUMNS, IFSC_ROWS)
    assert build.main(["--pincode-csv", str(pincode_csv), "--ifsc-csv", str(ifsc_csv)]) == 0
    shutil.copy(branches.DATA_DIR / branches.SAMPLE_BRANCHES_FILE, tmp_path / "out")
    caches = (branches.load_directory, branches.load_shipped_branches, branches._known_lenders, branches.resolve_lender)
    for cache in caches:
        cache.cache_clear()
    monkeypatch.setattr(branches, "DATA_DIR", tmp_path / "out")
    yield tmp_path / "out", pincode_csv, ifsc_csv
    for cache in caches:
        cache.cache_clear()


class TestMain:
    def test_writes_gzip_json_that_the_app_reads(self, built):
        out_dir, _, _ = built
        assert sorted(p.name for p in out_dir.iterdir()) == [
            "bank_branches.json.gz",
            "pincode_directory.json.gz",
            "sample_nbfc_branches.json",
        ]
        answer = branches.find("401201", ["HDFC Bank", "ICICI Bank"])
        hdfc = answer["lenders"][0]
        assert [(b["name"], b["pincode"], b["ifsc"]) for b in hdfc["branches"]] == [
            ("Vasai West", "401202", "HDFC0000001")
        ]
        assert 2 < hdfc["branches"][0]["distance_km"] < 5
        icici = answer["lenders"][1]
        assert [b["ifsc"] for b in icici["branches"]] == ["ICIC0000002", "ICIC0000001"]

    def test_the_same_inputs_give_the_same_bytes_with_their_hashes(self, built):
        out_dir, pincode_csv, ifsc_csv = built
        first = {p.name: p.read_bytes() for p in out_dir.glob("*.gz")}
        build.main(["--pincode-csv", str(pincode_csv), "--ifsc-csv", str(ifsc_csv)])
        assert {p.name: p.read_bytes() for p in out_dir.glob("*.gz")} == first
        directory = branches._gzip_json(build.DIRECTORY_FILE)
        assert len(directory["sha256"]) == 64
        assert json.dumps(directory, sort_keys=True)  # plain JSON throughout
