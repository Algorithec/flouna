#!/usr/bin/env python3
"""Validate every retained V7 Run 1 checkpoint.

    python data/v7/validate_checkpoints_v7.py

For each *_adapters.safetensors in the adapter directory record size, SHA-256,
safe-open result, tensor count, dtypes, shapes, key-set equality and a finite
check of every tensor. Writes data/v7/reports/v7_run1_checkpoints.json.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parents[1]
sys.path.insert(0, str(MODEL))

ADAPTER_DIR = MODEL / "flouna-lora-v7-run1-fixed"
REPORTS = HERE / "reports"
OUT = REPORTS / "v7_run1_checkpoints.json"

EXPECTED_LORA_TENSORS = 224


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    from safetensors import safe_open
    import mlx.core as mx

    files = sorted(ADAPTER_DIR.glob("*_adapters.safetensors"))
    if not files:
        raise SystemExit(f"no checkpoints found in {ADAPTER_DIR}")

    checkpoints: list[dict] = []
    reference_keys: set[str] | None = None
    errors: list[str] = []
    for path in files:
        match = re.match(r"(\d{7})_adapters\.safetensors$", path.name)
        entry: dict = {
            "file": path.name,
            "iteration": int(match.group(1)) if match else None,
            "size_bytes": path.stat().st_size,
            "sha256": sha256(path),
        }
        try:
            with safe_open(str(path), framework="mlx") as f:
                keys = sorted(f.keys())
                entry["safe_open"] = True
                entry["tensor_count"] = len(keys)
                if reference_keys is None:
                    reference_keys = set(keys)
                entry["key_set_matches_reference"] = set(keys) == reference_keys
                dtypes = sorted({str(f.get_tensor(k).dtype) for k in keys})
                entry["dtypes"] = dtypes
                shapes = {
                    "lora_a": sorted({tuple(f.get_tensor(k).shape)
                                      for k in keys if k.endswith(".lora_a")}),
                    "lora_b": sorted({tuple(f.get_tensor(k).shape)
                                      for k in keys if k.endswith(".lora_b")}),
                }
                entry["shapes"] = {k: [list(s) for s in v] for k, v in shapes.items()}
                bad = [k for k in keys
                       if k.endswith(".lora_a") and (len(f.get_tensor(k).shape) != 2
                                                      or f.get_tensor(k).shape[1] != 16)]
                bad += [k for k in keys
                        if k.endswith(".lora_b") and (len(f.get_tensor(k).shape) != 2
                                                       or f.get_tensor(k).shape[0] != 16)]
                entry["bad_rank_tensors"] = bad
                if bad:
                    errors.append(f"{path.name}: {len(bad)} tensors do not have rank 16")
                modules = sorted({k.split(".")[-2] for k in keys})
                entry["modules"] = modules
                if modules != ["down_proj", "gate_proj", "k_proj", "o_proj",
                               "q_proj", "up_proj", "v_proj"]:
                    errors.append(f"{path.name}: unexpected module set {modules}")
                nonfinite = [k for k in keys if not bool(mx.all(mx.isfinite(f.get_tensor(k))))]
                entry["nonfinite_tensors"] = nonfinite
                entry["finite"] = not nonfinite
                entry["keys_sample"] = keys[:3]
        except Exception as exc:  # noqa: BLE001 - report the failure verbatim
            entry["safe_open"] = False
            entry["error"] = f"{type(exc).__name__}: {exc}"
            errors.append(f"{path.name}: {entry['error']}")
        if entry.get("tensor_count") != EXPECTED_LORA_TENSORS:
            errors.append(f"{path.name}: {entry.get('tensor_count')} tensors, "
                          f"expected {EXPECTED_LORA_TENSORS}")
        checkpoints.append(entry)

    final = ADAPTER_DIR / "adapters.safetensors"
    final_match = None
    if final.exists():
        final_sha = sha256(final)
        same = [c for c in checkpoints if c["sha256"] == final_sha]
        final_match = {
            "file": final.name,
            "size_bytes": final.stat().st_size,
            "sha256": final_sha,
            "matches_checkpoint": same[0]["file"] if same else None,
        }
        if not same:
            errors.append("adapters.safetensors does not match any numbered checkpoint")
    else:
        errors.append("adapters.safetensors is missing")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "adapter_dir": str(ADAPTER_DIR),
        "expected_lora_tensors": EXPECTED_LORA_TENSORS,
        "checkpoints": checkpoints,
        "final_adapter": final_match,
        "errors": errors,
        "pass": not errors,
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for c in checkpoints:
        print(f"{c['file']}: {c['size_bytes']} bytes, {c.get('tensor_count')} tensors, "
              f"finite={c.get('finite')}, sha256={c['sha256'][:16]}")
    print("final:", final_match)
    print("errors:", errors or "none")
    print("CHECKPOINTS:", "PASS" if report["pass"] else "FAIL")
    print("wrote", OUT)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
