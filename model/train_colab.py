# Flouna: LoRA fine-tune of Qwen2.5-0.5B-Instruct on a free Colab T4.
# Aligned with production schema (domain, budgetPaise, dietary, vehicle, scheduleAt).
#
# Colab: Runtime > Change runtime type > T4 GPU
# Upload train.jsonl (from gen_data.py), then run these cells.
#
# Training takes ~15 min with 3000 examples on a T4.
# For 5-hour training: increase epochs to 5-8, or use Qwen2.5-1.5B-Instruct.

# %% 1. install (~2 min)
# !pip install -q unsloth

# %% 2. load model
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

# For 5-hour training on T4, you can upgrade to 1.5B:
#   model_name = "unsloth/Qwen2.5-1.5B-Instruct"
# 0.5B trains in ~15 min, 1.5B in ~45 min per epoch
model_name = "unsloth/Qwen2.5-0.5B-Instruct"

model, tok = FastLanguageModel.from_pretrained(
    model_name, max_seq_length=512, load_in_4bit=False)
model = FastLanguageModel.get_peft_model(
    model, r=32, lora_alpha=32, lora_dropout=0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"])

# %% 3. data
ds = load_dataset("json", data_files="train.jsonl", split="train")
ds = ds.map(lambda x: {"text": tok.apply_chat_template(x["messages"], tokenize=False)})

eval_ds = load_dataset("json", data_files="eval.jsonl", split="train")
eval_ds = eval_ds.map(lambda x: {"text": tok.apply_chat_template(x["messages"], tokenize=False)})

# %% 4. train
# With 3000 examples:
#   - 2 epochs (~15 min on T4): good baseline
#   - 5 epochs (~40 min): solid for production
#   - 8 epochs (~60 min): diminishing returns with 0.5B, try 1.5B instead
#
# For 5-hour training budget with 1.5B model:
#   - Use num_train_epochs=5, per_device_train_batch_size=8
#   - That gives ~5 hours on a T4
trainer = SFTTrainer(
    model=model, tokenizer=tok,
    train_dataset=ds,
    eval_dataset=eval_ds,
    args=SFTConfig(
        dataset_text_field="text",
        per_device_train_batch_size=16,
        gradient_accumulation_steps=1,
        num_train_epochs=5,
        learning_rate=2e-4,
        warmup_steps=10,
        logging_steps=20,
        eval_strategy="steps",
        eval_steps=100,
        save_strategy="steps",
        save_steps=200,
        max_seq_length=512,
        output_dir="out",
        report_to="none",
        fp16=True,
    ))
trainer = train_on_responses_only(
    trainer,
    instruction_part="<|im_start|>user\n",
    response_part="<|im_start|>assistant\n")
trainer.train()

# %% 5. quick check
FastLanguageModel.for_inference(model)

test_inputs = [
    "cheapest butter chicken under 300",
    "book a cab to the airport",
    "buy gaming laptop under 50000",
    "order pizza and a ride to home",
    "hello",
    "write me a python script",
]

system_msg = ds[0]["messages"][0]["content"]
for user_text in test_inputs:
    msgs = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_text},
    ]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to("cuda")
    out = model.generate(ids, max_new_tokens=200, temperature=0)
    decoded = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
    print(f"\nINPUT: {user_text}")
    print(f"OUTPUT: {decoded}")

# %% 6. export GGUF (~2 min), then download flouna_gguf/*.gguf
model.save_pretrained_gguf("flouna_gguf", tok, quantization_method="q4_k_m")
# After download, on your VPS/machine:
#   ollama create flouna -f Modelfile
#   (Modelfile references ./flouna.Q4_K_M.gguf — rename the downloaded file)

# %% 7. also save full-precision for later fine-tuning
model.save_pretrained_merged("flouna_full", tok, save_method="merged_16bit")
