"""Fine-tune Qwen2.5-1.5B-Instruct with LoRA on Apple Silicon using MLX.

Usage:
    cd model
    source .venv/bin/activate
    python train_1.5b.py

Takes ~1.5-2 hours on M3 16GB for 1000 iterations.
Peak memory ~10-12GB — close to the limit on 16GB, so close other apps.

NOTE: For NVIDIA GPUs, use train_peft_win.py instead (QLoRA, works on 4 GB VRAM).
"""
import json
import os
import subprocess
import sys

MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
TRAIN_FILE = "train.jsonl"
EVAL_FILE = "eval.jsonl"
OUTPUT_DIR = "flouna-lora-1.5b"
FUSED_DIR = "flouna-fused-1.5b"


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

                fout.write(json.dumps({
                    "messages": [
                        {"role": "system", "content": system_msg},
                        {"role": "user", "content": user_msg},
                        {"role": "assistant", "content": assistant_msg},
                    ]
                }, ensure_ascii=False) + "\n")
                count += 1

        print(f"  {split}: {count} examples → {outfile}")


def train():
    print("\n=== Step 1: Converting data ===")
    convert_data()

    print("\n=== Step 2: Starting LoRA fine-tuning (1.5B) ===")
    print(f"  Model: {MODEL}")
    print(f"  Output: {OUTPUT_DIR}/")
    print(f"  This will take ~1.5-2 hours on M3 16GB")
    print(f"  Close other apps to free memory\n")

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", MODEL,
        "--train",
        "--data", ".",
        "--batch-size", "4",
        "--num-layers", "16",
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
    print(f"  Fused model:   {FUSED_DIR}/")
    print(f"\n  Next steps:")
    print(f"  1. Create Ollama model:")
    print(f"     Update Modelfile: FROM ./flouna-fused-1.5b")
    print(f"     ollama create flouna -f Modelfile --quantize q8_0")
    print(f"  2. Test: ollama run flouna")


if __name__ == "__main__":
    train()
