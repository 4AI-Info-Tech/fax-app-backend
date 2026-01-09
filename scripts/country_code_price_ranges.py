import csv
import json
import argparse

def to_float(x):
    try:
        return float(str(x).strip())
    except:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Telnyx CSV")
    ap.add_argument("--out", default="country_price_ranges.json")
    args = ap.parse_args()

    rates = {}

    with open(args.input, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        # find columns (case insensitive)
        cols = {c.lower(): c for c in reader.fieldnames}

        if "country code" in cols:
            country_col = cols["country code"]
        elif "country_code" in cols:
            country_col = cols["country_code"]
        elif "iso" in cols:
            country_col = cols["iso"]
        else:
            raise Exception("CSV must contain Country Code, country_code, or ISO column")

        rate_col = None
        for k in ("rate", "price", "cost"):
            if k in cols:
                rate_col = cols[k]
                break

        if not rate_col:
            raise Exception("CSV must contain Rate column")

        for row in reader:
            cc = (row.get(country_col) or "").strip().upper()
            if not cc:
                continue

            rate = to_float(row.get(rate_col))
            if rate is None:
                continue

            rates.setdefault(cc, []).append(rate)

    result = {}

    for cc, arr in rates.items():
        arr = sorted(arr)
        result[cc] = [arr[0], arr[-1]]

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print("Wrote", args.out)
    print("Countries:", len(result))

if __name__ == "__main__":
    main()
