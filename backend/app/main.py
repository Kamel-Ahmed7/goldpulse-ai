"""
GoldPulse AI - FastAPI backend
==============================
Endpoints
  GET /api/health      -> service status
  GET /api/rates       -> live XAU/USD, USD/EGP and the Egyptian carat / coin / ingot matrix
  GET /api/predict     -> next-day prediction from models/gold_price_ridge_model.pkl
                          (9 features: OHLCV + Daily_Range, Daily_Return_%, MA50, MA200; /api/forecast is an alias)
  GET /api/gold-news   -> gold headlines with keyword-based sentiment

Every external call has a fallback, so the dashboard keeps working offline:
  XAU/USD : goldprice.org feed -> gold-api.com -> last close in data/XAU_1d_data.csv
  USD/EGP : open.er-api.com    -> GP_FALLBACK_USD_EGP (estimate)
  News    : Google News RSS    -> bundled sample headlines
  Model   : Ridge .pkl         -> simple trend extrapolation (flagged in the response)

Run (from the backend/ folder):
  uvicorn app.main:app --reload --port 8000
Then open http://localhost:8000  (the frontend/ folder is served by this app).
"""
from __future__ import annotations

import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import httpx
import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("goldpulse")
logging.basicConfig(level=logging.INFO)

# --------------------------------------------------------------------------- #
# Configuration (override with environment variables)
# --------------------------------------------------------------------------- #
ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "data" / "XAU_1d_data.csv"
MODEL_PATH = ROOT / "models" / "gold_price_ridge_model.pkl"
FRONTEND_DIR = ROOT / "frontend"

TROY_OZ_GRAMS = 31.1035
KARATS = [24, 22, 21, 18, 14]

# Local-market tuning. Egyptian shop prices differ from pure spot parity, so these are
# knobs, not facts. Set them to match the market you want to mirror.
LOCAL_PREMIUM = float(os.getenv("GP_LOCAL_PREMIUM", "0.0"))      # e.g. 0.03 = +3% over parity
SELL_MARKUP = float(os.getenv("GP_SELL_MARKUP", "0.0025"))       # shop sells above base
BUY_MARKDOWN = float(os.getenv("GP_BUY_MARKDOWN", "0.0045"))     # shop buys below base
FALLBACK_USD_EGP = float(os.getenv("GP_FALLBACK_USD_EGP", "50.0"))
SIGNAL_THRESHOLD = float(os.getenv("GP_SIGNAL_THRESHOLD", "0.30"))  # % move for BUY/SELL

# Gold pound (8 g, 21K) and ingots (24K): workmanship (مصنعية) in EGP per piece. Estimates in line with
# Egyptian portals (21K jewellery ~120-250 EGP/g); listed prices exclude stamp duty (دمغة).
COIN = {"grams": 8, "karat": 21, "workmanship": 250}
INGOTS = [(1, 120), (5, 250), (10, 400), (31.1, 800), (100, 1500)]

# --------------------------------------------------------------------------- #
# App + tiny TTL cache
# --------------------------------------------------------------------------- #
app = FastAPI(title="GoldPulse AI", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

_cache: dict[str, tuple[float, Any]] = {}


def cached(key: str, ttl: int, fn: Callable[[], Any]) -> Any:
    """Return a cached value for `ttl` seconds, otherwise call fn() and store it."""
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Historical data
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def load_history() -> pd.DataFrame:
    """Load XAU_1d_data.csv (handles ';' or ',' separators and any column casing)."""
    df = pd.read_csv(CSV_PATH, sep=None, engine="python")
    df.columns = [str(c).strip().lower() for c in df.columns]
    date_col = next((c for c in df.columns if c in ("date", "datetime", "time", "timestamp")), df.columns[0])
    df["date"] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=["date", "close"]).sort_values("date").reset_index(drop=True)
    return df


# --------------------------------------------------------------------------- #
# Live market data with fallbacks
# --------------------------------------------------------------------------- #
HEADERS = {"User-Agent": "Mozilla/5.0 (GoldPulseAI dashboard)"}


def fetch_xau() -> dict:
    """XAU/USD spot price per troy ounce, with daily change."""
    try:  # 1) goldprice.org public feed (includes daily change)
        r = httpx.get("https://data-asg.goldprice.org/dbXRates/USD", headers=HEADERS, timeout=6)
        r.raise_for_status()
        it = r.json()["items"][0]
        return {"price": float(it["xauPrice"]), "change": float(it.get("chgXau", 0)),
                "change_pct": float(it.get("pcXau", 0)), "source": "goldprice.org", "live": True}
    except Exception as exc:
        log.warning("goldprice.org failed: %s", exc)

    try:  # 2) gold-api.com (price only, change measured against the last CSV close)
        r = httpx.get("https://api.gold-api.com/price/XAU", headers=HEADERS, timeout=6)
        r.raise_for_status()
        price = float(r.json()["price"])
        ref = float(load_history()["close"].iloc[-1])
        return {"price": price, "change": price - ref, "change_pct": (price / ref - 1) * 100,
                "source": "gold-api.com", "live": True}
    except Exception as exc:
        log.warning("gold-api.com failed: %s", exc)

    # 3) Offline fallback: the latest rows of the local dataset
    close = load_history()["close"]
    last, prev = float(close.iloc[-1]), float(close.iloc[-2])
    return {"price": last, "change": last - prev, "change_pct": (last / prev - 1) * 100,
            "source": "local-csv (offline)", "live": False}


def fetch_usd_egp() -> dict:
    try:
        r = httpx.get("https://open.er-api.com/v6/latest/USD", timeout=6)
        r.raise_for_status()
        return {"rate": float(r.json()["rates"]["EGP"]), "source": "open.er-api.com", "live": True}
    except Exception as exc:
        log.warning("USD/EGP fetch failed: %s", exc)
        return {"rate": FALLBACK_USD_EGP, "source": "fallback estimate", "live": False}


def build_rates() -> dict:
    """Combine spot gold and the FX rate into the Egyptian price matrix."""
    xau = cached("xau", 20, fetch_xau)
    fx = cached("fx", 300, fetch_usd_egp)
    g24_egp = xau["price"] / TROY_OZ_GRAMS * fx["rate"] * (1 + LOCAL_PREMIUM)  # EGP per gram, 24K
    chg = round(xau["change_pct"], 2)

    def item(id_, name, name_ar, cat, unit, grams, karat, work):
        base = g24_egp * karat / 24 * grams
        return {"id": id_, "name": name, "name_ar": name_ar, "category": cat, "unit": unit,
                "karat": karat, "weight_g": grams, "workmanship": work,
                "sell": round(base * (1 + SELL_MARKUP) + work, 2),   # customer buys
                "buy": round(base * (1 - BUY_MARKDOWN), 2),          # customer sells back
                "change_pct": chg}

    items = [item(f"{k}k", f"{k}K Gold", f"عيار {k}", "carat", "per gram", 1, k, 0) for k in KARATS]
    items.append(item("coin", "Gold Pound (8g, 21K)", "جنيه ذهب", "coin", "per coin",
                      COIN["grams"], COIN["karat"], COIN["workmanship"]))
    for grams, work in INGOTS:
        items.append(item(f"ingot-{grams}", f"{grams:g}g Gold Ingot", f"سبيكة {grams:g} جرام",
                          "bullion", "per bar", grams, 24, work))

    return {
        "timestamp": now_iso(),
        "is_live": xau["live"],
        "source": xau["source"],
        "xauusd": {"price": round(xau["price"], 2), "change": round(xau["change"], 2), "change_pct": chg},
        "usd_egp": {"rate": round(fx["rate"], 4), "source": fx["source"], "live": fx["live"]},
        "gram_24k_usd": round(xau["price"] / TROY_OZ_GRAMS, 2),
        "items": items,
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "model_file": MODEL_PATH.exists(), "data_file": CSV_PATH.exists(), "time": now_iso()}


@app.get("/api/rates")
def rates():
    return cached("rates", 15, build_rates)


# --------------------------------------------------------------------------- #
# AI forecast
# --------------------------------------------------------------------------- #
# Exact 9 features (and order) the Ridge model was trained on.
MODEL_FEATURES = ["Open", "High", "Low", "Close", "Volume",
                  "Daily_Range", "Daily_Return_%", "MA50", "MA200"]


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Recreate the training notebook's feature table from the raw CSV (columns are lower-cased on load)."""
    feats = pd.DataFrame(index=df.index)
    for name in ("Open", "High", "Low", "Close", "Volume"):          # raw OHLCV columns
        if name.lower() not in df:
            raise ValueError(f"Column '{name}' not found in XAU_1d_data.csv")
        feats[name] = df[name.lower()].astype(float)
    feats["Daily_Range"] = df["high"] - df["low"]                    # High - Low
    feats["Daily_Return_%"] = df["close"].pct_change() * 100         # % change in Close
    feats["MA50"] = df["close"].rolling(50).mean()                   # 50-day moving average
    feats["MA200"] = df["close"].rolling(200).mean()                 # 200-day moving average
    return feats[MODEL_FEATURES]                                     # enforce the exact column order


@lru_cache(maxsize=1)
def load_model():
    return joblib.load(MODEL_PATH)


def run_model(df: pd.DataFrame) -> dict:
    """
    Take the latest complete row of the dataset, build the 9-column feature row and call predict().
    Raises on any problem so the caller can report it and fall back.
    """
    obj = load_model()
    model, scaler = obj, None
    if isinstance(obj, dict):  # also supports {"model": ..., "scaler": ...} bundles
        model = obj.get("model") or obj.get("pipeline") or obj.get("estimator")
        scaler = obj.get("scaler")

    feats = engineer_features(df).dropna()            # drops rows without a full 200-day window
    if feats.empty:
        raise ValueError("Need at least 200 rows in XAU_1d_data.csv to compute MA200")
    idx = feats.index[-1]
    row = feats.loc[[idx], MODEL_FEATURES]

    # If the model remembers its training columns, honour their exact order.
    trained = getattr(model, "feature_names_in_", None)
    if trained is not None:
        if set(map(str, trained)) != set(MODEL_FEATURES):
            raise ValueError(f"Model expects {list(trained)}, backend provides {MODEL_FEATURES}")
        row = row[[str(c) for c in trained]]
        X = row
    else:
        X = row.to_numpy()
    if scaler is not None:
        X = scaler.transform(row.to_numpy())

    raw = float(np.ravel(model.predict(X))[0])
    last_close = float(df.loc[idx, "close"])
    # The model targets tomorrow's close; a tiny output would mean it returns a fraction instead.
    pred = last_close * (1 + raw) if abs(raw) < 1 < last_close else raw
    return {
        "pred": pred,
        "model_name": type(model).__name__,
        "features": {k: round(float(v), 4) for k, v in row.iloc[0].items()},
        "row_date": df.loc[idx, "date"].strftime("%Y-%m-%d"),
        "last_close": last_close,
    }


def trend_fallback(df: pd.DataFrame) -> float:
    """Linear extrapolation of the last 10 closes. Used only if the model cannot run."""
    y = df["close"].astype(float).tail(10).to_numpy()
    slope, intercept = np.polyfit(np.arange(len(y)), y, 1)
    return float(slope * len(y) + intercept)


@app.get("/api/predict")
@app.get("/api/forecast", include_in_schema=False)   # old path kept as an alias
def predict():
    """Tomorrow's close from the Ridge model, the % move, a signal and the 21K EGP estimate."""
    df = load_history()
    warnings: list[str] = []
    notes: list[str] = []
    try:
        res = run_model(df)
        pred, last, used_model, model_name = res["pred"], res["last_close"], True, res["model_name"]
        features, row_date = res["features"], res["row_date"]
    except Exception as exc:
        log.exception("Model prediction failed")
        last, row_date, features = float(df["close"].iloc[-1]), df["date"].iloc[-1].strftime("%Y-%m-%d"), {}
        pred, used_model, model_name = trend_fallback(df), False, "Trend extrapolation (fallback)"
        warnings.append(f"Model unavailable, using trend fallback: {exc}")

    ret = (pred / last - 1) * 100
    signal = "BUY" if ret > SIGNAL_THRESHOLD else "SELL" if ret < -SIGNAL_THRESHOLD else "NEUTRAL"

    # Apply the model's predicted % move to the live spot, then convert with the live USD/EGP rate.
    market = cached("rates", 15, build_rates)
    live, fx = market["xauusd"]["price"], market["usd_egp"]["rate"]
    if abs(live / last - 1) > 0.15:
        notes.append(f"The dataset's last close (${last:,.0f}, {row_date}) is far from live spot (${live:,.0f}). "
                     "The EGP estimate applies the predicted % move to the live price. Refresh XAU_1d_data.csv for best accuracy.")
    est_21k = live * (1 + ret / 100) / TROY_OZ_GRAMS * 21 / 24 * fx * (1 + LOCAL_PREMIUM)

    hist = df.tail(60)
    return {
        "model_used": used_model,
        "model_name": model_name,
        "as_of": row_date,
        "features": features,
        "last_close": round(last, 2),
        "predicted_close": round(pred, 2),
        "predicted_return_pct": round(ret, 3),
        "signal": signal,
        "signal_threshold_pct": SIGNAL_THRESHOLD,
        "live_price": live,
        "usd_egp": fx,
        "est_21k_egp_gram": round(est_21k, 2),
        "history": [{"d": d.strftime("%Y-%m-%d"), "c": round(float(v), 2)} for d, v in zip(hist["date"], hist["close"])],
        "warnings": warnings,
        "notes": notes,
    }


# --------------------------------------------------------------------------- #
# News + sentiment
# --------------------------------------------------------------------------- #
BULLISH = ["surge", "rally", "rise", "climb", "gain", "record", "high", "safe-haven", "safe haven", "rate cut",
           "cut rates", "dovish", "weaker dollar", "demand", "buying", "soar", "jump", "boost", "inflation fears"]
BEARISH = ["fall", "drop", "slip", "decline", "plunge", "slump", "lower", "rate hike", "hawkish", "stronger dollar",
           "strong dollar", "selloff", "sell-off", "outflow", "pressure", "retreat", "tumble", "loss"]

SAMPLE_NEWS = [
    ("Gold steadies as traders weigh Fed rate outlook", "Sample feed"),
    ("Central bank buying keeps gold supported near highs", "Sample feed"),
    ("Dollar strength pressures bullion ahead of inflation data", "Sample feed"),
]


def sentiment(title: str) -> str:
    t = title.lower()
    score = sum(w in t for w in BULLISH) - sum(w in t for w in BEARISH)
    return "Bullish" if score > 0 else "Bearish" if score < 0 else "Neutral"


def fetch_news() -> dict:
    url = "https://news.google.com/rss/search?q=gold+price+OR+XAUUSD+OR+bullion&hl=en-US&gl=US&ceid=US:en"
    try:
        r = httpx.get(url, headers=HEADERS, timeout=8, follow_redirects=True)
        r.raise_for_status()
        out = []
        for node in ET.fromstring(r.text).findall("./channel/item")[:20]:
            raw = (node.findtext("title") or "").strip()
            src = (node.findtext("source") or "").strip()
            title = re.sub(rf"\s+-\s+{re.escape(src)}$", "", raw) if src else raw
            try:
                ts = parsedate_to_datetime(node.findtext("pubDate")).astimezone(timezone.utc).isoformat()
            except Exception:
                ts = now_iso()
            out.append({"title": title, "source": src or "Google News", "url": node.findtext("link"),
                        "published": ts, "sentiment": sentiment(title)})
        if out:
            return {"fallback": False, "articles": out}
    except Exception as exc:
        log.warning("News fetch failed: %s", exc)
    return {"fallback": True, "articles": [
        {"title": t, "source": s, "url": None, "published": now_iso(), "sentiment": sentiment(t)}
        for t, s in SAMPLE_NEWS]}


@app.get("/api/gold-news")
def gold_news():
    data = cached("news", 300, fetch_news)
    counts = {"Bullish": 0, "Neutral": 0, "Bearish": 0}
    for a in data["articles"]:
        counts[a["sentiment"]] += 1
    overall = max(counts, key=counts.get)
    return {**data, "counts": counts, "overall": overall, "timestamp": now_iso()}


# --------------------------------------------------------------------------- #
# Serve the frontend (registered last so /api/* routes win)
# --------------------------------------------------------------------------- #
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

#===============================================
from pathlib import Path

# تحديد مجلد الجذر بالصعود من backend/app/main.py
BASE_DIR = Path(__file__).resolve().parent.parent.parent

MODEL_PATH = BASE_DIR / "models" / "gold_price_ridge_model.pkl"
DATA_PATH = BASE_DIR / "data" / "XAU_1d_data.csv"