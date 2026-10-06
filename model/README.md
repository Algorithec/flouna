# Flouna Intent Model

Fine-tuned Qwen2.5-0.5B for intent extraction. Runs locally via Ollama — zero API cost.

## Architecture

```
user text → Qwen 0.5B (intent JSON) → provider quotes (ONDC/APIs) → scoring → decision
```

The model ONLY parses intent. The decision is deterministic math.

## Quick start

```bash
# 1. Generate training data (3000+ examples)
python gen_data.py

# 2. Train on Colab T4 (~15 min for 0.5B, ~5h for 1.5B)
#    Upload train.jsonl to Colab, run train_colab.py
#    Download the .gguf file

# 3. Deploy with Ollama
ollama create flouna -f Modelfile

# 4. Evaluate
python eval.py                    # test fine-tuned model
python eval.py --rules-only       # test regex fallback
python eval.py --model qwen2.5:0.5b  # test base model
```

## Files

| File | Purpose |
|------|---------|
| `gen_data.py` | Generates train.jsonl (3000) + eval.jsonl (300) |
| `train_colab.py` | LoRA fine-tune on free Colab T4, exports GGUF |
| `eval.py` | Measures accuracy per field (domain, priority, budget, etc.) |
| `Modelfile` | Ollama model definition |
| `train.jsonl` | Training data (generated) |
| `eval.jsonl` | Evaluation data (generated, no overlap with train) |

## Training data quality

- Budget is ONLY set when the user explicitly states one (no hallucination)
- Prices in paise (₹300 = 30000) matching production schema
- Covers all 6 domains: food, ride, shop, combo, greeting, out_of_scope
- Includes Hinglish, typos, mixed case, adversarial inputs
- ~30% of examples have explicit budgets, ~70% have null (realistic)

## 5-hour training plan

| Time | Task |
|------|------|
| 0:00 | Generate data with `python gen_data.py` |
| 0:10 | Upload train.jsonl to Colab, start training |
| 0:25 | 0.5B model done — download GGUF, run eval |
| 0:30 | Switch to Qwen2.5-1.5B-Instruct, train 5 epochs |
| 1:30 | 1.5B model done — download GGUF, compare eval scores |
| 2:00 | Review eval errors, improve gen_data.py, regenerate |
| 3:00 | Retrain best model on improved data |
| 4:00 | Final eval, deploy to Ollama |
| 5:00 | Done — production-ready model |

## VPS requirements

- ~1 GB RAM for 0.5B q4 model (no GPU needed)
- ~2 GB RAM for 1.5B q4 model (no GPU needed)
- Ollama installed (`curl -fsSL https://ollama.com/install.sh | sh`)
