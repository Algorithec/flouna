#!/usr/bin/env python3
"""Dry run for configs/v7_run1_fixed.yaml. Loads everything, optimizes nothing.

Verifies that the fixed dataset loads through the same mlx-lm path training
uses, every row tokenizes within max_seq_length, every loss mask is non-empty,
the first train and validation batches build with non-empty masks, the base
model loads, the LoRA configuration applies, and one forward loss per split is
finite. No optimizer step, no adapter directory, no checkpoint.

    python data/v7/dry_run_v7_fixed.py
"""
from __future__ import annotations

import json
import math
import sys
import time
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
sys.path.insert(0, str(MODEL))
sys.path.insert(0, str(HERE))

import yaml  # noqa: E402
import mlx.core as mx  # noqa: E402
from mlx_lm.lora import CONFIG_DEFAULTS, load_dataset  # noqa: E402
from mlx_lm.tuner.datasets import CacheDataset  # noqa: E402
from mlx_lm.tuner.trainer import default_loss, iterate_batches  # noqa: E402
from mlx_lm.tuner.utils import get_total_parameters, linear_to_lora_layers  # noqa: E402
from mlx_lm.utils import load as load_model  # noqa: E402
from mlx.utils import tree_flatten  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

import token_preflight_v7 as TP  # noqa: E402

CONFIG = MODEL / "configs/v7_run1_fixed.yaml"
OUT = HERE / "reports/v7_fixed_dry_run.json"


def main() -> int:
    started = time.time()
    checks: list[dict] = []

    def check(name: str, ok: bool, detail) -> None:
        checks.append({"name": name, "pass": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name, "->", detail)

    cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    params = dict(CONFIG_DEFAULTS)
    params.update(cfg)
    args = Namespace(**params)
    adapter_path = Path(args.adapter_path)

    check("fixed output directory absent", not adapter_path.exists(), str(adapter_path))
    check("no resume adapter requested", args.resume_adapter_file is None,
          args.resume_adapter_file)
    check("max_seq_length is 1152", args.max_seq_length == 1152, args.max_seq_length)
    check("LoRA recipe unchanged",
          args.lora_parameters["rank"] == 16 and args.lora_parameters["scale"] == 2.0
          and args.num_layers == 16 and args.batch_size == 1
          and args.grad_accumulation_steps == 4 and args.seed == 11,
          {k: args.lora_parameters[k] for k in ("rank", "scale", "dropout")}
          | {"layers": args.num_layers, "batch": args.batch_size,
             "accum": args.grad_accumulation_steps, "seed": args.seed})

    tokenizer = AutoTokenizer.from_pretrained(
        args.model, trust_remote_code=args.trust_remote_code)
    check("tokenizer loads", True, type(tokenizer).__name__)

    token = TP.analyse_root(TP.FIXED_ROOT, TP.fixed_systems(), tokenizer)
    for split, entry in token["splits"].items():
        check(f"{split}: every row tokenizes and fits",
              entry["pass"],
              {"rows": entry["rows"],
               "max_tokens": entry["sequence_tokens"]["max"],
               "empty_masks": entry["counts"]["empty_loss_masks"]})

    train_set, valid_set, test_set = load_dataset(args, tokenizer)
    check("training split loads", len(train_set) == 4147, len(train_set))
    check("validation split loads", len(valid_set) == 225, len(valid_set))
    check("no test split configured", len(test_set) == 0, len(test_set))

    train_cached = CacheDataset(train_set)
    valid_cached = CacheDataset(valid_set)
    train_batch, train_lengths = next(iterate_batches(
        train_cached, args.batch_size, args.max_seq_length, seed=args.seed))
    valid_batch, valid_lengths = next(iterate_batches(
        valid_cached, args.batch_size, args.max_seq_length, seed=args.seed + 1))
    train_mask = [int(total - offset) for offset, total in train_lengths.tolist()]
    valid_mask = [int(total - offset) for offset, total in valid_lengths.tolist()]
    check("first training batch built", train_batch.size > 0,
          {"shape": list(train_batch.shape), "loss_mask_tokens": train_mask})
    check("first validation batch built", valid_batch.size > 0,
          {"shape": list(valid_batch.shape), "loss_mask_tokens": valid_mask})
    check("first batches have non-empty loss masks",
          all(n > 0 for n in train_mask + valid_mask), {"train": train_mask,
                                                        "valid": valid_mask})

    model, _ = load_model(
        args.model,
        tokenizer_config={"trust_remote_code": args.trust_remote_code},
        trust_remote_code=args.trust_remote_code,
    )
    check("base model loads", True, args.model)

    model.freeze()
    linear_to_lora_layers(model, args.num_layers, dict(args.lora_parameters))
    total_params = get_total_parameters(model)
    trainable = sum(v.size for _, v in tree_flatten(model.trainable_parameters()))
    fraction = round(100 * trainable / total_params, 3)
    check("LoRA configuration applies", 0 < trainable < total_params,
          {"trainable": trainable, "total": total_params,
           "percent": fraction, "layers": args.num_layers})

    model.eval()
    tic = time.time()
    train_loss, train_tokens = default_loss(model, train_batch, train_lengths)
    mx.eval(train_loss)
    train_loss_value = float(train_loss)
    valid_loss, valid_tokens = default_loss(model, valid_batch, valid_lengths)
    mx.eval(valid_loss)
    valid_loss_value = float(valid_loss)
    forward_secs = round(time.time() - tic, 3)
    check("forward loss finite on first training batch",
          math.isfinite(train_loss_value),
          {"loss": round(train_loss_value, 5), "tokens": int(train_tokens)})
    check("forward loss finite on first validation batch",
          math.isfinite(valid_loss_value),
          {"loss": round(valid_loss_value, 5), "tokens": int(valid_tokens)})
    check("adapter directory still absent after preflight",
          not adapter_path.exists(), str(adapter_path))

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config": str(CONFIG),
        "adapter_path": str(adapter_path),
        "optimizer_steps": 0,
        "adapter_written": False,
        "model": args.model,
        "data": args.data,
        "max_seq_length": args.max_seq_length,
        "checks": checks,
        "pass": all(c["pass"] for c in checks),
        "forward": {
            "train_loss": round(train_loss_value, 5),
            "valid_loss": round(valid_loss_value, 5),
            "train_tokens": int(train_tokens),
            "valid_tokens": int(valid_tokens),
            "seconds": forward_secs,
        },
        "lora": {"trainable_params": trainable, "total_params": total_params,
                 "percent": fraction},
        "elapsed_seconds": round(time.time() - started, 2),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    print("DRY RUN:", "PASS" if report["pass"] else "FAIL")
    print("wrote", OUT)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
