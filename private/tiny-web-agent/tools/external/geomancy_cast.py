from __future__ import annotations

import hashlib
import random
import secrets
from typing import Any

FIGURES = {
    "0000":"Populus","1111":"Via","0011":"Fortuna Major","1100":"Fortuna Minor",
    "0101":"Acquisitio","1010":"Amissio","1000":"Laetitia","0001":"Tristitia",
    "1101":"Puer","1011":"Puella","0100":"Rubeus","0010":"Albus",
    "0110":"Conjunctio","1001":"Carcer","0111":"Caput Draconis","1110":"Cauda Draconis",
}
HOUSE_NAMES = ["Vita","Lucrum","Fratres","Genitor","Nati","Valetudo","Uxor","Mors","Itineris","Regnum","Benefacta","Carcer"]
ELEMENTS = ["Fire","Air","Water","Earth"]


def _fig(bits: list[int]) -> dict[str, Any]:
    key = "".join(str(x) for x in bits)
    return {"bits": bits, "key": key, "name": FIGURES[key], "points": sum(1 if b else 2 for b in bits)}


def _add(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    return _fig([x ^ y for x, y in zip(a["bits"], b["bits"])])


def _house_mod(n: int) -> int:
    value = n % 12
    return 12 if value == 0 else value


def geomancy_cast(query: str, nonce: str = "") -> dict[str, Any]:
    """Generate a reproducible classical geomantic shield/house chart."""
    nonce = str(nonce or "").strip() or secrets.token_hex(16)
    query = str(query or "").strip()
    seed_text = f"{query}\u241f{nonce}"
    digest = hashlib.sha256(seed_text.encode("utf-8")).digest()
    rng = random.Random(int.from_bytes(digest, "big"))

    mothers = [_fig([rng.getrandbits(1) for _ in range(4)]) for _ in range(4)]
    daughters = [_fig([m["bits"][row] for m in mothers]) for row in range(4)]
    nieces = [
        _add(mothers[0], mothers[1]), _add(mothers[2], mothers[3]),
        _add(daughters[0], daughters[1]), _add(daughters[2], daughters[3]),
    ]
    right_witness = _add(nieces[0], nieces[1])
    left_witness = _add(nieces[2], nieces[3])
    judge = _add(right_witness, left_witness)
    sentence = _add(judge, mothers[0])
    houses = mothers + daughters + nieces
    all_figures = houses + [right_witness, left_witness, judge, sentence]
    triplicities = [
        [houses[0], houses[1], houses[8]],
        [houses[2], houses[3], houses[9]],
        [houses[4], houses[5], houses[10]],
        [houses[6], houses[7], houses[11]],
    ]

    return {
        "query": query,
        "nonce": nonce,
        "seed_sha256": hashlib.sha256(seed_text.encode("utf-8")).hexdigest(),
        "mothers": mothers,
        "daughters": daughters,
        "nieces": nieces,
        "court": {
            "right_witness": right_witness,
            "left_witness": left_witness,
            "judge": judge,
            "sentence": sentence,
        },
        "houses": [{"house": i + 1, "traditional_name": HOUSE_NAMES[i], **f} for i, f in enumerate(houses)],
        "triplicities": [[f["name"] for f in group] for group in triplicities],
        "lots": {
            "part_of_fortune": _house_mod(sum(f["points"] for f in houses)),
            "part_of_spirit": _house_mod(sum(sum(f["bits"]) for f in houses)),
        },
        "chart_sum": sum(f["points"] for f in all_figures),
        "benchmark_sum": 96,
    }
