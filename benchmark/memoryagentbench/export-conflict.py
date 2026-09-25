"""Export the official MemoryAgentBench Conflict Resolution parquet to JSON.

PyArrow is used only because the upstream release is Parquet. The generated
JSON lives under benchmark/memoryagentbench/data/ and is gitignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import pyarrow.parquet as pq


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    rows = pq.read_table(args.parquet).to_pylist()
    selected = {
        row["metadata"]["source"]: row
        for row in rows
        if row["metadata"]["source"] in {
            "factconsolidation_sh_6k",
            "factconsolidation_mh_6k",
        }
    }
    if set(selected) != {"factconsolidation_sh_6k", "factconsolidation_mh_6k"}:
        raise ValueError("official 6K single-hop/multi-hop rows were not found")

    single = selected["factconsolidation_sh_6k"]
    multi = selected["factconsolidation_mh_6k"]
    if single["context"] != multi["context"]:
        raise ValueError("the official 6K single-hop and multi-hop knowledge pools differ")

    facts = [
        {"serial": int(match.group(1)), "text": match.group(2).strip()}
        for match in re.finditer(r"(?m)^(\d+)\.\s+(.*)$", single["context"])
    ]
    if not facts or [fact["serial"] for fact in facts] != list(range(len(facts))):
        raise ValueError("knowledge-pool serials are incomplete or out of order")

    def questions(row: dict) -> list[dict]:
        ids = row["metadata"]["qa_pair_ids"]
        return [
            {"id": ids[index], "question": question, "answers": row["answers"][index]}
            for index, question in enumerate(row["questions"])
        ]

    payload = {
        "benchmark": "MemoryAgentBench",
        "task": "Conflict_Resolution",
        "variant": "6k",
        "source": "ai-hyz/MemoryAgentBench",
        "context_sha256": hashlib.sha256(single["context"].encode("utf-8")).hexdigest(),
        "facts": facts,
        "questions": {
            "single_hop": questions(single),
            "multi_hop": questions(multi),
        },
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"exported {len(facts)} facts, "
        f"{len(payload['questions']['single_hop'])} single-hop questions, "
        f"{len(payload['questions']['multi_hop'])} multi-hop questions -> {output}"
    )


if __name__ == "__main__":
    main()
