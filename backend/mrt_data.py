"""
Static Singapore MRT/LRT station data and schedule-based wait estimates.
Coordinates are approximate station centres.
"""
from collections import deque

STATIONS: dict[str, dict] = {
    # ── East West Line ────────────────────────────────────────
    "EW1":  {"name": "Pasir Ris",        "lat": 1.3731, "lng": 103.9496},
    "EW2":  {"name": "Tampines",         "lat": 1.3530, "lng": 103.9450},
    "EW3":  {"name": "Simei",            "lat": 1.3432, "lng": 103.9530},
    "EW4":  {"name": "Tanah Merah",      "lat": 1.3273, "lng": 103.9463},
    "EW5":  {"name": "Bedok",            "lat": 1.3240, "lng": 103.9300},
    "EW6":  {"name": "Kembangan",        "lat": 1.3208, "lng": 103.9132},
    "EW7":  {"name": "Eunos",            "lat": 1.3196, "lng": 103.9030},
    "EW8":  {"name": "Paya Lebar",       "lat": 1.3180, "lng": 103.8924},
    "EW9":  {"name": "Aljunied",         "lat": 1.3163, "lng": 103.8828},
    "EW10": {"name": "Kallang",          "lat": 1.3115, "lng": 103.8711},
    "EW11": {"name": "Lavender",         "lat": 1.3073, "lng": 103.8634},
    "EW12": {"name": "Bugis",            "lat": 1.3008, "lng": 103.8565},
    "EW13": {"name": "City Hall",        "lat": 1.2930, "lng": 103.8520},
    "EW14": {"name": "Raffles Place",    "lat": 1.2840, "lng": 103.8516},
    "EW15": {"name": "Tanjong Pagar",    "lat": 1.2765, "lng": 103.8454},
    "EW16": {"name": "Outram Park",      "lat": 1.2803, "lng": 103.8394},
    "EW17": {"name": "Tiong Bahru",      "lat": 1.2863, "lng": 103.8270},
    "EW18": {"name": "Redhill",          "lat": 1.2894, "lng": 103.8165},
    "EW19": {"name": "Queenstown",       "lat": 1.2944, "lng": 103.8061},
    "EW20": {"name": "Commonwealth",     "lat": 1.3022, "lng": 103.7984},
    "EW21": {"name": "Buona Vista",      "lat": 1.3073, "lng": 103.7898},
    "EW22": {"name": "Dover",            "lat": 1.3111, "lng": 103.7787},
    "EW23": {"name": "Clementi",         "lat": 1.3151, "lng": 103.7651},
    "EW24": {"name": "Jurong East",      "lat": 1.3331, "lng": 103.7422},
    "EW25": {"name": "Chinese Garden",   "lat": 1.3424, "lng": 103.7323},
    "EW26": {"name": "Lakeside",         "lat": 1.3441, "lng": 103.7213},
    "EW27": {"name": "Boon Lay",         "lat": 1.3386, "lng": 103.7060},
    "EW28": {"name": "Pioneer",          "lat": 1.3378, "lng": 103.6968},
    "EW29": {"name": "Joo Koon",         "lat": 1.3278, "lng": 103.6784},
    "EW30": {"name": "Gul Circle",       "lat": 1.3195, "lng": 103.6609},
    "EW31": {"name": "Tuas Crescent",    "lat": 1.3209, "lng": 103.6488},
    "EW32": {"name": "Tuas West Road",   "lat": 1.3300, "lng": 103.6393},
    "EW33": {"name": "Tuas Link",        "lat": 1.3407, "lng": 103.6366},
    # ── North South Line ──────────────────────────────────────
    "NS1":  {"name": "Jurong East",      "lat": 1.3331, "lng": 103.7422},
    "NS2":  {"name": "Bukit Batok",      "lat": 1.3492, "lng": 103.7496},
    "NS3":  {"name": "Bukit Gombak",     "lat": 1.3589, "lng": 103.7516},
    "NS4":  {"name": "Choa Chu Kang",    "lat": 1.3854, "lng": 103.7448},
    "NS5":  {"name": "Yew Tee",          "lat": 1.3970, "lng": 103.7473},
    "NS7":  {"name": "Kranji",           "lat": 1.4253, "lng": 103.7621},
    "NS8":  {"name": "Marsiling",        "lat": 1.4326, "lng": 103.7746},
    "NS9":  {"name": "Woodlands",        "lat": 1.4369, "lng": 103.7864},
    "NS10": {"name": "Admiralty",        "lat": 1.4408, "lng": 103.8010},
    "NS11": {"name": "Sembawang",        "lat": 1.4489, "lng": 103.8198},
    "NS12": {"name": "Canberra",         "lat": 1.4432, "lng": 103.8299},
    "NS13": {"name": "Yishun",           "lat": 1.4294, "lng": 103.8353},
    "NS14": {"name": "Khatib",           "lat": 1.4172, "lng": 103.8330},
    "NS15": {"name": "Yio Chu Kang",     "lat": 1.3817, "lng": 103.8449},
    "NS16": {"name": "Ang Mo Kio",       "lat": 1.3700, "lng": 103.8496},
    "NS17": {"name": "Bishan",           "lat": 1.3510, "lng": 103.8484},
    "NS18": {"name": "Braddell",         "lat": 1.3404, "lng": 103.8470},
    "NS19": {"name": "Toa Payoh",        "lat": 1.3326, "lng": 103.8473},
    "NS20": {"name": "Novena",           "lat": 1.3203, "lng": 103.8438},
    "NS21": {"name": "Newton",           "lat": 1.3124, "lng": 103.8382},
    "NS22": {"name": "Orchard",          "lat": 1.3041, "lng": 103.8322},
    "NS23": {"name": "Somerset",         "lat": 1.3006, "lng": 103.8388},
    "NS24": {"name": "Dhoby Ghaut",      "lat": 1.2990, "lng": 103.8455},
    "NS25": {"name": "City Hall",        "lat": 1.2930, "lng": 103.8520},
    "NS26": {"name": "Raffles Place",    "lat": 1.2840, "lng": 103.8516},
    "NS27": {"name": "Marina Bay",       "lat": 1.2765, "lng": 103.8543},
    "NS28": {"name": "Marina South Pier","lat": 1.2706, "lng": 103.8633},
    # ── North East Line ───────────────────────────────────────
    "NE1":  {"name": "HarbourFront",     "lat": 1.2654, "lng": 103.8204},
    "NE3":  {"name": "Outram Park",      "lat": 1.2803, "lng": 103.8394},
    "NE4":  {"name": "Chinatown",        "lat": 1.2845, "lng": 103.8445},
    "NE5":  {"name": "Clarke Quay",      "lat": 1.2884, "lng": 103.8462},
    "NE6":  {"name": "Dhoby Ghaut",      "lat": 1.2990, "lng": 103.8455},
    "NE7":  {"name": "Little India",     "lat": 1.3065, "lng": 103.8517},
    "NE8":  {"name": "Farrer Park",      "lat": 1.3124, "lng": 103.8544},
    "NE9":  {"name": "Boon Keng",        "lat": 1.3198, "lng": 103.8611},
    "NE10": {"name": "Potong Pasir",     "lat": 1.3316, "lng": 103.8686},
    "NE11": {"name": "Woodleigh",        "lat": 1.3394, "lng": 103.8704},
    "NE12": {"name": "Serangoon",        "lat": 1.3499, "lng": 103.8730},
    "NE13": {"name": "Kovan",            "lat": 1.3600, "lng": 103.8852},
    "NE14": {"name": "Hougang",          "lat": 1.3712, "lng": 103.8924},
    "NE15": {"name": "Buangkok",         "lat": 1.3829, "lng": 103.8925},
    "NE16": {"name": "Sengkang",         "lat": 1.3917, "lng": 103.8954},
    "NE17": {"name": "Punggol",          "lat": 1.4051, "lng": 103.9022},
    # ── Circle Line ───────────────────────────────────────────
    "CC1":  {"name": "Dhoby Ghaut",      "lat": 1.2990, "lng": 103.8455},
    "CC2":  {"name": "Bras Basah",       "lat": 1.2965, "lng": 103.8502},
    "CC3":  {"name": "Esplanade",        "lat": 1.2934, "lng": 103.8554},
    "CC4":  {"name": "Promenade",        "lat": 1.2936, "lng": 103.8607},
    "CC5":  {"name": "Nicoll Highway",   "lat": 1.2997, "lng": 103.8634},
    "CC6":  {"name": "Stadium",          "lat": 1.3026, "lng": 103.8749},
    "CC7":  {"name": "Mountbatten",      "lat": 1.3061, "lng": 103.8820},
    "CC8":  {"name": "Dakota",           "lat": 1.3083, "lng": 103.8883},
    "CC9":  {"name": "Paya Lebar",       "lat": 1.3180, "lng": 103.8924},
    "CC10": {"name": "MacPherson",       "lat": 1.3266, "lng": 103.8900},
    "CC11": {"name": "Tai Seng",         "lat": 1.3356, "lng": 103.8878},
    "CC12": {"name": "Bartley",          "lat": 1.3428, "lng": 103.8798},
    "CC13": {"name": "Serangoon",        "lat": 1.3499, "lng": 103.8730},
    "CC14": {"name": "Lorong Chuan",     "lat": 1.3514, "lng": 103.8644},
    "CC15": {"name": "Bishan",           "lat": 1.3510, "lng": 103.8484},
    "CC16": {"name": "Marymount",        "lat": 1.3467, "lng": 103.8394},
    "CC17": {"name": "Caldecott",        "lat": 1.3376, "lng": 103.8323},
    "CC19": {"name": "Botanic Gardens",  "lat": 1.3223, "lng": 103.8152},
    "CC20": {"name": "Farrer Road",      "lat": 1.3175, "lng": 103.8076},
    "CC21": {"name": "Holland Village",  "lat": 1.3113, "lng": 103.7963},
    "CC22": {"name": "Buona Vista",      "lat": 1.3073, "lng": 103.7898},
    "CC23": {"name": "one-north",        "lat": 1.2998, "lng": 103.7873},
    "CC24": {"name": "Kent Ridge",       "lat": 1.2937, "lng": 103.7844},
    "CC25": {"name": "Haw Par Villa",    "lat": 1.2825, "lng": 103.7820},
    "CC26": {"name": "Pasir Panjang",    "lat": 1.2763, "lng": 103.7914},
    "CC27": {"name": "Labrador Park",    "lat": 1.2724, "lng": 103.8026},
    "CC28": {"name": "Telok Blangah",    "lat": 1.2706, "lng": 103.8095},
    "CC29": {"name": "HarbourFront",     "lat": 1.2654, "lng": 103.8204},
    # ── Downtown Line ─────────────────────────────────────────
    "DT1":  {"name": "Bukit Panjang",    "lat": 1.3783, "lng": 103.7762},
    "DT2":  {"name": "Cashew",           "lat": 1.3697, "lng": 103.7836},
    "DT3":  {"name": "Hillview",         "lat": 1.3621, "lng": 103.7672},
    "DT5":  {"name": "Beauty World",     "lat": 1.3412, "lng": 103.7759},
    "DT6":  {"name": "King Albert Park", "lat": 1.3354, "lng": 103.7838},
    "DT7":  {"name": "Sixth Avenue",     "lat": 1.3307, "lng": 103.7968},
    "DT8":  {"name": "Tan Kah Kee",      "lat": 1.3249, "lng": 103.8077},
    "DT9":  {"name": "Botanic Gardens",  "lat": 1.3223, "lng": 103.8152},
    "DT10": {"name": "Stevens",          "lat": 1.3202, "lng": 103.8257},
    "DT11": {"name": "Newton",           "lat": 1.3124, "lng": 103.8382},
    "DT12": {"name": "Little India",     "lat": 1.3065, "lng": 103.8517},
    "DT13": {"name": "Rochor",           "lat": 1.3034, "lng": 103.8556},
    "DT14": {"name": "Bugis",            "lat": 1.3008, "lng": 103.8565},
    "DT15": {"name": "Promenade",        "lat": 1.2936, "lng": 103.8607},
    "DT16": {"name": "Bayfront",         "lat": 1.2823, "lng": 103.8594},
    "DT17": {"name": "Downtown",         "lat": 1.2791, "lng": 103.8528},
    "DT18": {"name": "Telok Ayer",       "lat": 1.2822, "lng": 103.8483},
    "DT19": {"name": "Chinatown",        "lat": 1.2845, "lng": 103.8445},
    "DT20": {"name": "Fort Canning",     "lat": 1.2917, "lng": 103.8440},
    "DT21": {"name": "Bencoolen",        "lat": 1.2983, "lng": 103.8497},
    "DT22": {"name": "Jalan Besar",      "lat": 1.3048, "lng": 103.8556},
    "DT23": {"name": "Bendemeer",        "lat": 1.3141, "lng": 103.8615},
    "DT24": {"name": "Geylang Bahru",    "lat": 1.3213, "lng": 103.8710},
    "DT25": {"name": "Mattar",           "lat": 1.3273, "lng": 103.8832},
    "DT26": {"name": "MacPherson",       "lat": 1.3266, "lng": 103.8900},
    "DT27": {"name": "Ubi",              "lat": 1.3298, "lng": 103.8989},
    "DT28": {"name": "Kaki Bukit",       "lat": 1.3353, "lng": 103.9068},
    "DT29": {"name": "Bedok North",      "lat": 1.3341, "lng": 103.9166},
    "DT30": {"name": "Bedok Reservoir",  "lat": 1.3362, "lng": 103.9326},
    "DT31": {"name": "Tampines West",    "lat": 1.3454, "lng": 103.9380},
    "DT32": {"name": "Tampines",         "lat": 1.3530, "lng": 103.9450},
    "DT33": {"name": "Tampines East",    "lat": 1.3568, "lng": 103.9538},
    "DT34": {"name": "Upper Changi",     "lat": 1.3413, "lng": 103.9610},
    "DT35": {"name": "Expo",             "lat": 1.3353, "lng": 103.9613},
    # ── Thomson-East Coast Line ───────────────────────────────
    "TE1":  {"name": "Woodlands North",  "lat": 1.4481, "lng": 103.8195},
    "TE2":  {"name": "Woodlands",        "lat": 1.4369, "lng": 103.7864},
    "TE3":  {"name": "Woodlands South",  "lat": 1.4251, "lng": 103.7968},
    "TE4":  {"name": "Springleaf",       "lat": 1.4039, "lng": 103.8162},
    "TE5":  {"name": "Lentor",           "lat": 1.3866, "lng": 103.8355},
    "TE6":  {"name": "Mayflower",        "lat": 1.3742, "lng": 103.8383},
    "TE7":  {"name": "Bright Hill",      "lat": 1.3624, "lng": 103.8376},
    "TE8":  {"name": "Upper Thomson",    "lat": 1.3543, "lng": 103.8319},
    "TE9":  {"name": "Caldecott",        "lat": 1.3376, "lng": 103.8323},
    "TE11": {"name": "Stevens",          "lat": 1.3202, "lng": 103.8257},
    "TE12": {"name": "Napier",           "lat": 1.3059, "lng": 103.8177},
    "TE13": {"name": "Orchard Boulevard","lat": 1.3015, "lng": 103.8227},
    "TE14": {"name": "Orchard",          "lat": 1.3041, "lng": 103.8322},
    "TE15": {"name": "Great World",      "lat": 1.2944, "lng": 103.8227},
    "TE16": {"name": "Havelock",         "lat": 1.2880, "lng": 103.8352},
    "TE17": {"name": "Outram Park",      "lat": 1.2803, "lng": 103.8394},
    "TE18": {"name": "Maxwell",          "lat": 1.2796, "lng": 103.8444},
    "TE19": {"name": "Shenton Way",      "lat": 1.2773, "lng": 103.8497},
    "TE20": {"name": "Marina Bay",       "lat": 1.2765, "lng": 103.8543},
    "TE22": {"name": "Gardens by the Bay","lat": 1.2815, "lng": 103.8631},
    "TE23": {"name": "Tanjong Rhu",      "lat": 1.2978, "lng": 103.8708},
    "TE24": {"name": "Katong Park",      "lat": 1.3018, "lng": 103.8820},
    "TE25": {"name": "Tanjong Katong",   "lat": 1.3023, "lng": 103.8909},
    "TE26": {"name": "Marine Parade",    "lat": 1.3028, "lng": 103.9007},
    "TE27": {"name": "Marine Terrace",   "lat": 1.3056, "lng": 103.9110},
    "TE28": {"name": "Siglap",           "lat": 1.3102, "lng": 103.9260},
    "TE29": {"name": "Bayshore",         "lat": 1.3167, "lng": 103.9392},
    "TE30": {"name": "Bedok South",      "lat": 1.3226, "lng": 103.9492},
    "TE31": {"name": "Sungei Bedok",     "lat": 1.3299, "lng": 103.9604},
}

LINE_SEQUENCES: dict[str, list[str]] = {
    "EWL": ["EW33","EW32","EW31","EW30","EW29","EW28","EW27","EW26","EW25","EW24",
            "EW23","EW22","EW21","EW20","EW19","EW18","EW17","EW16","EW15","EW14",
            "EW13","EW12","EW11","EW10","EW9","EW8","EW7","EW6","EW5","EW4","EW3","EW2","EW1"],
    "NSL": ["NS1","NS2","NS3","NS4","NS5","NS7","NS8","NS9","NS10","NS11","NS12",
            "NS13","NS14","NS15","NS16","NS17","NS18","NS19","NS20","NS21","NS22",
            "NS23","NS24","NS25","NS26","NS27","NS28"],
    "NEL": ["NE1","NE3","NE4","NE5","NE6","NE7","NE8","NE9","NE10","NE11",
            "NE12","NE13","NE14","NE15","NE16","NE17"],
    "CCL": ["CC1","CC2","CC3","CC4","CC5","CC6","CC7","CC8","CC9","CC10",
            "CC11","CC12","CC13","CC14","CC15","CC16","CC17","CC19","CC20",
            "CC21","CC22","CC23","CC24","CC25","CC26","CC27","CC28","CC29"],
    "DTL": ["DT1","DT2","DT3","DT5","DT6","DT7","DT8","DT9","DT10","DT11",
            "DT12","DT13","DT14","DT15","DT16","DT17","DT18","DT19","DT20",
            "DT21","DT22","DT23","DT24","DT25","DT26","DT27","DT28","DT29",
            "DT30","DT31","DT32","DT33","DT34","DT35"],
    "TEL": ["TE1","TE2","TE3","TE4","TE5","TE6","TE7","TE8","TE9","TE11",
            "TE12","TE13","TE14","TE15","TE16","TE17","TE18","TE19","TE20",
            "TE22","TE23","TE24","TE25","TE26","TE27","TE28","TE29","TE30","TE31"],
}

LINE_DISPLAY: dict[str, dict] = {
    "EWL": {"name": "East West Line",           "color": "#009645"},
    "NSL": {"name": "North South Line",          "color": "#d42e12"},
    "NEL": {"name": "North East Line",           "color": "#9900aa"},
    "CCL": {"name": "Circle Line",               "color": "#fa9e0d"},
    "DTL": {"name": "Downtown Line",             "color": "#005ec4"},
    "TEL": {"name": "Thomson-East Coast Line",   "color": "#9d5b25"},
}

# Headway-based wait (half-headway, rounded) by line × period
_WAITS = {
    "EWL": (2, 4), "NSL": (2, 4), "NEL": (2, 4),
    "CCL": (2, 4), "DTL": (2, 4), "TEL": (3, 5),
}


def is_peak(hour: int, day: int) -> bool:
    if day >= 5:
        return False
    return (7 <= hour < 9) or (17 <= hour < 20)


def mrt_wait_min(line: str, hour: int, day: int) -> int:
    peak_w, off_w = _WAITS.get(line, (3, 5))
    return peak_w if is_peak(hour, day) else off_w


# ── Build adjacency for MRT BFS ──────────────────────────────────────────────

def _build_adj() -> dict[str, list[tuple[str, str]]]:
    adj: dict[str, list[tuple[str, str]]] = {c: [] for c in STATIONS}

    # Within-line neighbours
    for line, seq in LINE_SEQUENCES.items():
        for i, code in enumerate(seq):
            if i > 0:
                adj[code].append((seq[i - 1], line))
            if i < len(seq) - 1:
                adj[code].append((seq[i + 1], line))

    # Interchange transfers (same station name → different code)
    name_to_codes: dict[str, list[str]] = {}
    for code, info in STATIONS.items():
        name_to_codes.setdefault(info["name"], []).append(code)
    for codes in name_to_codes.values():
        if len(codes) > 1:
            for c1 in codes:
                for c2 in codes:
                    if c1 != c2:
                        adj[c1].append((c2, "XFER"))

    return adj


_ADJ = _build_adj()

# Pre-compute code → line (first line in LINE_SEQUENCES for that code)
_CODE_LINE: dict[str, str] = {}
for _line, _seq in LINE_SEQUENCES.items():
    for _code in _seq:
        if _code not in _CODE_LINE:
            _CODE_LINE[_code] = _line


def find_mrt_path(from_code: str, to_code: str) -> list[dict] | None:
    """
    BFS from from_code to to_code on the MRT graph.
    Returns a list of leg dicts (type='mrt'), or None if unreachable.
    Each leg is one contiguous ride on a single line.
    """
    if from_code == to_code:
        return []
    if from_code not in _ADJ or to_code not in _ADJ:
        return None

    # BFS: state = current code, track path
    queue: deque[tuple[str, list[str]]] = deque([(from_code, [from_code])])
    visited: set[str] = {from_code}

    while queue:
        node, path = queue.popleft()
        for nbr, _ in _ADJ[node]:
            if nbr == to_code:
                return _path_to_legs(path + [nbr])
            if nbr not in visited:
                visited.add(nbr)
                queue.append((nbr, path + [nbr]))

    return None


def _path_to_legs(path: list[str]) -> list[dict]:
    """Convert a raw station-code path into grouped MRT legs (one per line)."""
    if len(path) < 2:
        return []

    legs: list[dict] = []
    leg_codes: list[str] = [path[0]]
    cur_line: str | None = None

    for i in range(1, len(path)):
        prev, curr = path[i - 1], path[i]
        connecting_line: str | None = None
        for nbr, edge_line in _ADJ.get(prev, []):
            if nbr == curr and edge_line != "XFER":
                connecting_line = edge_line
                break

        if connecting_line is None:
            # Transfer edge — flush current leg
            if len(leg_codes) >= 2 and cur_line:
                legs.append(_make_leg(leg_codes, cur_line))
            leg_codes = [curr]
            cur_line = None
        else:
            if cur_line is None:
                cur_line = connecting_line
            elif cur_line != connecting_line:
                if len(leg_codes) >= 2:
                    legs.append(_make_leg(leg_codes, cur_line))
                leg_codes = [prev, curr]
                cur_line = connecting_line
            else:
                leg_codes.append(curr)

    if len(leg_codes) >= 2 and cur_line:
        legs.append(_make_leg(leg_codes, cur_line))

    return legs


def _make_leg(codes: list[str], line: str) -> dict:
    return {
        "type":            "mrt",
        "line":            line,
        "line_name":       LINE_DISPLAY.get(line, {}).get("name", line),
        "line_color":      LINE_DISPLAY.get(line, {}).get("color", "#888"),
        "from_code":       codes[0],
        "from_station":    STATIONS[codes[0]]["name"],
        "to_code":         codes[-1],
        "to_station":      STATIONS[codes[-1]]["name"],
        "stations_count":  len(codes) - 1,
        "est_ride_min":    max(2, (len(codes) - 1) * 2),  # ~2 min/station
    }


def nearest_station(lat: float, lng: float, max_m: float = 2000) -> tuple[str, float] | None:
    """Return (station_code, distance_m) for the nearest MRT station within max_m metres."""
    import math
    best_code, best_dist = None, float("inf")
    for code, info in STATIONS.items():
        dlat = math.radians(info["lat"] - lat)
        dlng = math.radians(info["lng"] - lng)
        a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat)) * math.cos(math.radians(info["lat"])) * math.sin(dlng / 2) ** 2
        dist = 2 * 6371000 * math.asin(math.sqrt(a))
        if dist < best_dist:
            best_dist, best_code = dist, code
    if best_dist <= max_m:
        return best_code, best_dist
    return None
