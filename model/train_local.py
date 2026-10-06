"""Local fine-tuning on Apple Silicon using MLX.

Usage:
    source .venv/bin/activate
    python train_local.py

Trains Qwen2.5-0.5B-Instruct with LoRA on your Mac's M-series GPU.
Takes ~20-40 min on M3 16GB for 1000 iterations.
"""
import json
import os
import subprocess
import sys

MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
TRAIN_FILE = "train.jsonl"
EVAL_FILE = "eval.jsonl"
OUTPUT_DIR = "flouna-lora"
FUSED_DIR = "flouna-fused"

LORA_CONFIG = {
    "num_layers": 16,
    "lora_parameters": {
        "rank": 16,
        "alpha": 32,
        "dropout": 0.0,
        "scale": 2.0,
    },
    "keys": [
        "self_attn.q_proj",
        "self_attn.k_proj",
        "self_attn.v_proj",
        "self_attn.o_proj",
        "mlp.gate_proj",
        "mlp.up_proj",
        "mlp.down_proj",
    ],
}


def convert_data():
    """Convert chat-format JSONL to MLX completions format."""
    for split, infile, outfile in [
        ("train", TRAIN_FILE, "train_mlx.jsonl"),
        ("eval", EVAL_FILE, "eval_mlx.jsonl"),
    ]:
        if not os.path.exists(infile):
            print(f"Missing {infile} — run gen_data.py first")
            sys.exit(1)

        count = 0
        with open(infile) as fin, open(outfile, "w") as fout:
            for line in fin:
                row = json.loads(line)
                msgs = row["messages"]
                system_msg = msgs[0]["content"]
                user_msg = msgs[1]["content"]
                assistant_msg = msgs[2]["content"]

                # MLX chat format
                fout.write(json.dumps({
                    "messages": [
                        {"role": "system", "content": system_msg},
                        {"role": "user", "content": user_msg},
                        {"role": "assistant", "content": assistant_msg},
                    ]
                }, ensure_ascii=False) + "\n")
                count += 1

        print(f"  {split}: {count} examples → {outfile}")


def write_lora_config():
    with open("lora_config.yaml", "w") as f:
        import yaml
        yaml.dump(LORA_CONFIG, f, default_flow_style=False)


def train():
    print("\n=== Step 1: Converting data ===")
    convert_data()

    print("\n=== Step 2: Starting LoRA fine-tuning ===")
    print(f"  Model: {MODEL}")
    print(f"  Output: {OUTPUT_DIR}/")
    print(f"  This will take ~20-40 min on M3 16GB\n")

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", MODEL,
        "--train",
        "--data", ".",
        "--batch-size", "4",
        "--lora-layers", "16",
        "--iters", "1000",
        "--val-batches", "25",
        "--learning-rate", "1e-5",
        "--steps-per-report", "50",
        "--steps-per-eval", "200",
        "--adapter-path", OUTPUT_DIR,
        "--seed", "42",
    ]

    print(f"  Running: {' '.join(cmd)}\n")
    result = subprocess.run(cmd, cwd=os.path.dirname(os.path.abspath(__file__)))

    if result.returncode != 0:
        print("\nTraining failed!")
        sys.exit(1)

    print(f"\n=== Step 3: Fusing LoRA weights ===")
    fuse_cmd = [
        sys.executable, "-m", "mlx_lm.fuse",
        "--model", MODEL,
        "--adapter-path", OUTPUT_DIR,
        "--save-path", FUSED_DIR,
    ]
    print(f"  Running: {' '.join(fuse_cmd)}\n")
    subprocess.run(fuse_cmd, cwd=os.path.dirname(os.path.abspath(__file__)))

    print(f"\n=== Done! ===")
    print(f"  LoRA adapters: {OUTPUT_DIR}/")
    print(f"  Fused model: {FUSED_DIR}/")
    print(f"\n  To test: python test_local.py")
    print(f"  To convert for Ollama: python export_gguf.py")


if __name__ == "__main__":
    train()
