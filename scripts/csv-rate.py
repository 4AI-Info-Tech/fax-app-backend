import csv
import json
from collections import defaultdict

INPUT_CSV = "telnyx_rates.csv"
OUTPUT_JSON = "rate-table.json"

# micro-USD per minute
def to_micro(rate_str):
    return int(round(float(rate_str) * 1_000_000))

rate_map = {}

print("Loading CSV...")

with open(INPUT_CSV, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        prefix = row["Destination Prefixes"].strip()
        rate = row["Rate"].strip()

        if not prefix or not rate:
            continue

        # Telnyx prefixes are numeric strings
        if not prefix.isdigit():
            continue

        rate_map[prefix] = to_micro(rate)

print(f"Loaded {len(rate_map)} prefixes")

# Build prefix closure
# If 1234298 exists, we also need:
# 1,12,123,1234,12342,123429
expanded = {}

for prefix, rate in rate_map.items():
    for i in range(1, len(prefix) + 1):
        p = prefix[:i]
        if p not in expanded:
            expanded[p] = rate_map.get(p, None)

# Now resolve missing prefixes to closest shorter rate
# This makes longest-prefix matching work
for p in list(expanded.keys()):
    if expanded[p] is None:
        for i in range(len(p) - 1, 0, -1):
            parent = p[:i]
            if parent in rate_map:
                expanded[p] = rate_map[parent]
                break

# Remove unresolved (rare)
expanded = {k: v for k, v in expanded.items() if v is not None}

# Sort lexicographically so binary search works
prefixes = sorted(expanded.keys())
rates = [expanded[p] for p in prefixes]

print(f"Final prefix count: {len(prefixes)}")

out = {
    "prefixes": prefixes,
    "rates": rates
}

with open(OUTPUT_JSON, "w") as f:
    json.dump(out, f, separators=(",", ":"))

print("Written:", OUTPUT_JSON)
