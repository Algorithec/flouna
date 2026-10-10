"""QLoRA fine-tune of Qwen2.5-1.5B-Instruct on Windows / NVIDIA (4 GB VRAM).

Replaces the MLX run (train_1.5b.py). Mirrors it: batch 2, ~4200 iters
(~1.55 epochs over 5400 examples). Differences:
  - 4-bit base model + fp16 so it fits a 4 GB Turing GPU (no bf16 on RTX 20xx)
  - loss on the assistant JSON only (system prompt + user tokens masked)
  - LoRA LR 2e-4 (1e-5 is a full-fine-tune LR; too low for LoRA)

Usage:
    cd model
    .venv\\Scripts\\python -u train_peft_win.py            # fresh run
    .venv\\Scripts\\python -u train_peft_win.py --resume   # continue from last checkpoint
"""
import json
import sys

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)

MODEL_ID = "Qwen/Qwen2.5-1.5B-Instruct"
TRAIN_FILE = "train_mlx.jsonl"
EVAL_FILE = "eval_mlx.jsonl"
OUTPUT_DIR = "flouna-lora-1.5b-peft"
MAX_STEPS = 4200
BATCH_SIZE = 1
GRAD_ACCUM = 2           # effective batch 2, same as the MLX run
LR = 2e-4
LORA_R = 16
LORA_ALPHA = 32
LORA_DROPOUT = 0.05
MAX_LEN = 1536

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token


def encode(messages):
    """Tokenize a chat; labels are -100 everywhere except the assistant reply."""
    prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(messages, tokenize=False)
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    full_ids = tokenizer(full, add_special_tokens=False)["input_ids"][:MAX_LEN]
    labels = [-100] * len(prompt_ids) + full_ids[len(prompt_ids):]
    return {"input_ids": full_ids, "labels": labels[:len(full_ids)]}


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        rows = [encode(json.loads(line)["messages"]) for line in f if line.strip()]
    return Dataset.from_list(rows)


def collate(batch):
    width = max(len(b["input_ids"]) for b in batch)
    ids, labels, mask = [], [], []
    for b in batch:
        pad = width - len(b["input_ids"])
        ids.append(b["input_ids"] + [tokenizer.pad_token_id] * pad)
        labels.append(b["labels"] + [-100] * pad)
        mask.append([1] * len(b["input_ids"]) + [0] * pad)
    return {
        "input_ids": torch.tensor(ids),
        "labels": torch.tensor(labels),
        "attention_mask": torch.tensor(mask),
    }


@torch.no_grad()
def eval_loss(model, ds):
    """Mean per-token loss on the assistant JSON, one example at a time."""
    model.eval()
    total, tokens = 0.0, 0
    for i, row in enumerate(ds):
        batch = {k: v.to(model.device) for k, v in collate([row]).items()}
        with torch.autocast("cuda", dtype=torch.float16):
            loss = model(**batch).loss.item()
        n = sum(1 for x in row["labels"] if x != -100) - 1
        total, tokens = total + loss * n, tokens + n
        if (i + 1) % 50 == 0:
            print(f"  eval {i + 1}/{len(ds)}  running loss {total / tokens:.4f}", flush=True)
    return total / tokens


def main():
    resume = "--resume" in sys.argv

    train_ds = load_jsonl(TRAIN_FILE)
    eval_full = load_jsonl(EVAL_FILE)
    lens = [len(x) for x in train_ds["input_ids"]]
    print(f"Train: {len(train_ds)}, Eval: {len(eval_full)}")
    print(f"Tokens/example: max {max(lens)}, mean {sum(lens) / len(lens):.0f}")
    print(f"Steps: {MAX_STEPS} x batch {BATCH_SIZE * GRAD_ACCUM} = "
          f"{MAX_STEPS * BATCH_SIZE * GRAD_ACCUM / len(train_ds):.2f} epochs", flush=True)

    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        ),
        torch_dtype=torch.float16,
        device_map={"": 0},
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
    ))
    model.print_trainable_parameters()

    trainer = Trainer(
        model=model,
        args=TrainingArguments(
            output_dir=OUTPUT_DIR,
            max_steps=MAX_STEPS,
            per_device_train_batch_size=BATCH_SIZE,
            per_device_eval_batch_size=1,
            gradient_accumulation_steps=GRAD_ACCUM,
            gradient_checkpointing=True,
            gradient_checkpointing_kwargs={"use_reentrant": False},
            learning_rate=LR,
            lr_scheduler_type="cosine",
            warmup_steps=100,
            max_grad_norm=1.0,
            fp16=True,
            optim="paged_adamw_8bit",
            logging_steps=25,
            # Trainer eval spills a 4 GB GPU into shared memory (~85 s/example),
            # so eval once at the end with eval_loss() instead.
            eval_strategy="no",
            save_steps=200,
            save_total_limit=3,
            report_to="none",
            dataloader_num_workers=0,
            remove_unused_columns=False,
            seed=42,
        ),
        train_dataset=train_ds,
        data_collator=collate,
    )

    trainer.train(resume_from_checkpoint=resume or None)
    trainer.save_model(OUTPUT_DIR + "/final")
    tokenizer.save_pretrained(OUTPUT_DIR + "/final")

    trainer.optimizer = None
    torch.cuda.empty_cache()
    print(f"FINAL eval_loss ({len(eval_full)} examples): {eval_loss(model, eval_full):.4f}")
    print("Done! Adapter saved to:", OUTPUT_DIR + "/final")


if __name__ == "__main__":
    main()
