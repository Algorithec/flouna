#!/usr/bin/env python3
"""Export the fused FLOUNA 1.5B v6 model to an F16 GGUF.

Same writer as export_gguf_v5.py (mlx_lm's GGUF export does not cover Qwen2),
pointed at the V6 fused directory so the V5 artifacts are never touched.

Run from model/:  .venv/bin/python export_gguf_v6.py
Then:             llama-quantize flouna-1.5b-v6-f16.gguf flouna-1.5b-v6-q8.gguf Q8_0
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import gguf
import mlx.core as mx
import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE / "flouna-1.5b-v6-fused"
OUT = HERE / "flouna-1.5b-v6-f16.gguf"

CONTROL = int(gguf.TokenType.CONTROL)
NORMAL = int(gguf.TokenType.NORMAL)
F16 = 1  # GGMLFileType.MostF16

LAYER_RE = re.compile(r"^model\.layers\.(\d+)\.(.+)$")

PER_LAYER = {
    "input_layernorm.weight": "attn_norm.weight",
    "post_attention_layernorm.weight": "ffn_norm.weight",
    "self_attn.q_proj.weight": "attn_q.weight",
    "self_attn.q_proj.bias": "attn_q.bias",
    "self_attn.k_proj.weight": "attn_k.weight",
    "self_attn.k_proj.bias": "attn_k.bias",
    "self_attn.v_proj.weight": "attn_v.weight",
    "self_attn.v_proj.bias": "attn_v.bias",
    "self_attn.o_proj.weight": "attn_output.weight",
    "mlp.gate_proj.weight": "ffn_gate.weight",
    "mlp.up_proj.weight": "ffn_up.weight",
    "mlp.down_proj.weight": "ffn_down.weight",
}


def gguf_name(hf_name: str) -> str:
    if hf_name == "model.embed_tokens.weight":
        return "token_embd.weight"
    if hf_name == "model.norm.weight":
        return "output_norm.weight"
    m = LAYER_RE.match(hf_name)
    if not m:
        raise KeyError(f"unmapped tensor: {hf_name}")
    layer, rest = int(m.group(1)), m.group(2)
    if rest not in PER_LAYER:
        raise KeyError(f"unmapped tensor: {hf_name}")
    return f"blk.{layer}.{PER_LAYER[rest]}"


def build_vocab(tokenizer: dict, vocab_size: int) -> tuple[list[str], list[int], list[str]]:
    base = tokenizer["model"]["vocab"]
    n_base = max(base.values()) + 1
    if len(base) != n_base:
        raise ValueError(f"non-contiguous base vocab: {len(base)} entries, max id {n_base - 1}")

    tokens: list[str] = [""] * n_base
    for piece, idx in base.items():
        tokens[idx] = piece

    types: list[int] = [NORMAL] * n_base

    for added in sorted(tokenizer["added_tokens"], key=lambda t: t["id"]):
        idx = added["id"]
        if idx != len(tokens):
            raise ValueError(f"added token id {idx} is not contiguous with {len(tokens)}")
        tokens.append(added["content"])
        types.append(CONTROL if added.get("special") else NORMAL)

    if len(tokens) > vocab_size:
        raise ValueError(f"tokenizer has {len(tokens)} tokens but embedding rows are {vocab_size}")
    while len(tokens) < vocab_size:
        tokens.append(f"<unused{len(tokens)}>")
        types.append(NORMAL)

    merges = []
    for merge in tokenizer["model"]["merges"]:
        merges.append(" ".join(merge) if isinstance(merge, list) else merge)

    return tokens, types, merges


def main() -> int:
    cfg = json.loads((SRC / "config.json").read_text(encoding="utf-8"))
    tok = json.loads((SRC / "tokenizer.json").read_text(encoding="utf-8"))
    template = (SRC / "chat_template.jinja").read_text(encoding="utf-8")

    if cfg["model_type"] != "qwen2":
        raise SystemExit(f"expected qwen2, found {cfg['model_type']}")

    vocab_size = int(cfg["vocab_size"])
    tokens, types, merges = build_vocab(tok, vocab_size)
    print(f"tokens={len(tokens)} control={types.count(CONTROL)} merges={len(merges)}")

    weights = mx.load(str(SRC / "model.safetensors"))
    expected = 2 + 12 * int(cfg["num_hidden_layers"])
    if len(weights) != expected:
        raise SystemExit(f"expected {expected} tensors, found {len(weights)}")

    writer = gguf.GGUFWriter(str(OUT), "qwen2", use_temp_file=True)
    writer.add_name("flouna-1.5b-v6")
    writer.add_file_type(F16)
    writer.add_context_length(int(cfg["max_position_embeddings"]))
    writer.add_embedding_length(int(cfg["hidden_size"]))
    writer.add_block_count(int(cfg["num_hidden_layers"]))
    writer.add_feed_forward_length(int(cfg["intermediate_size"]))
    writer.add_head_count(int(cfg["num_attention_heads"]))
    writer.add_head_count_kv(int(cfg["num_key_value_heads"]))
    writer.add_layer_norm_rms_eps(float(cfg["rms_norm_eps"]))
    writer.add_rope_freq_base(float(cfg["rope_theta"]))
    writer.add_vocab_size(vocab_size)

    writer.add_tokenizer_model("gpt2")
    writer.add_tokenizer_pre("qwen2")
    writer.add_token_list(tokens)
    writer.add_token_types(types)
    writer.add_token_merges(merges)
    writer.add_bos_token_id(int(cfg["bos_token_id"]))
    writer.add_eos_token_id(int(cfg["eos_token_id"][0]))
    writer.add_pad_token_id(151643)
    writer.add_add_bos_token(False)
    writer.add_add_eos_token(False)
    writer.add_chat_template(template)

    total = 0
    for name in sorted(weights):
        # Matrices go out as f16; norms and biases stay f32, matching the
        # upstream converter (llama.cpp's RMSNorm op cannot mix f32/f16).
        dtype = np.float16 if weights[name].ndim == 2 else np.float32
        arr = np.array(weights[name].astype(mx.float32 if dtype is np.float32 else mx.float16))
        arr = np.ascontiguousarray(arr, dtype=dtype)
        writer.add_tensor(gguf_name(name), arr)
        total += arr.nbytes
    print(f"tensors={len(weights)} payload={total / 1e9:.3f} GB -> {OUT}")

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e9:.3f} GB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
