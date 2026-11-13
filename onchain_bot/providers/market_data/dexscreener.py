"""DexScreener Market Data Provider with batching, rate limiting, and fail-closed error handling."""

import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Optional, Any
from onchain_bot.models.types import TokenMetadata, TokenState


class DexScreenerProvider:
    BASE_URL = "https://api.dexscreener.com"

    def __init__(self, requests_per_minute: int = 250):
        self.min_interval = 60.0 / requests_per_minute
        self.last_request_time = 0.0
        self.circuit_open = False
        self.circuit_reset_time = 0.0
        self.failure_count = 0

    def _rate_limit(self) -> None:
        now = time.time()
        if self.circuit_open:
            if now < self.circuit_reset_time:
                raise RuntimeError("DexScreener circuit breaker is OPEN due to repeated upstream failures")
            else:
                self.circuit_open = False
                self.failure_count = 0

        elapsed = now - self.last_request_time
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self.last_request_time = time.time()

    def _http_get(self, endpoint: str) -> Optional[Any]:
        self._rate_limit()
        url = f"{self.BASE_URL}{endpoint}"
        headers = {"User-Agent": "OnChainSpotBot/2.0 (Security Engine)"}
        req = urllib.request.Request(url, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                if resp.status == 200:
                    self.failure_count = 0
                    return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:  # Rate limited
                time.sleep(2.0)
            self.failure_count += 1
            if self.failure_count >= 5:
                self.circuit_open = True
                self.circuit_reset_time = time.time() + 30.0
            return None
        except Exception:
            self.failure_count += 1
            if self.failure_count >= 5:
                self.circuit_open = True
                self.circuit_reset_time = time.time() + 30.0
            return None

    def get_latest_profiles(self) -> List[Dict[str, Any]]:
        data = self._http_get("/token-profiles/latest/v1")
        if isinstance(data, list):
            return data
        return []

    def get_latest_boosts(self) -> List[Dict[str, Any]]:
        data = self._http_get("/token-boosts/latest/v1")
        if isinstance(data, list):
            return data
        return []

    def search_pairs(self, query: str) -> List[Dict[str, Any]]:
        encoded = urllib.parse.quote(query) if hasattr(urllib, "parse") else query
        data = self._http_get(f"/latest/dex/search?q={encoded}")
        if data and isinstance(data, dict):
            return data.get("pairs") or []
        return []

    def get_tokens_batch(self, chain_id: str, token_addresses: List[str]) -> List[TokenMetadata]:
        """Fetches up to 30 tokens in a single batch request."""
        if not token_addresses:
            return []
        
        batch = token_addresses[:30]
        joined = ",".join(batch)
        endpoint = f"/tokens/v1/{chain_id}/{joined}"
        data = self._http_get(endpoint)

        results = []
        if data and isinstance(data, list):
            for item in data:
                token_meta = self._parse_dex_pair(item, chain_id)
                if token_meta:
                    results.append(token_meta)
        return results

    def _parse_dex_pair(self, item: Dict[str, Any], chain: str) -> Optional[TokenMetadata]:
        try:
            base_token = item.get("baseToken") or {}
            quote_token = item.get("quoteToken") or {}
            pair_addr = item.get("pairAddress") or base_token.get("address", "")

            price_usd = None
            if item.get("priceUsd"):
                try:
                    price_usd = float(item["priceUsd"])
                except (ValueError, TypeError):
                    pass

            liq_usd = None
            liq_dict = item.get("liquidity") or {}
            if liq_dict.get("usd") is not None:
                try:
                    liq_usd = float(liq_dict["usd"])
                except (ValueError, TypeError):
                    pass

            vol_usd = None
            vol_dict = item.get("volume") or {}
            if vol_dict.get("h24") is not None:
                try:
                    vol_usd = float(vol_dict["h24"])
                except (ValueError, TypeError):
                    pass

            txns = item.get("txns") or {}
            h24_txns = txns.get("h24") or {}
            buys = h24_txns.get("buys")
            sells = h24_txns.get("sells")

            price_change = item.get("priceChange") or {}
            p1h = price_change.get("h1")
            p24h = price_change.get("h24")

            return TokenMetadata(
                chain=chain.lower(),
                token_address=base_token.get("address", "").strip(),
                pair_address=pair_addr.strip(),
                symbol=base_token.get("symbol", "UNKNOWN").upper(),
                name=base_token.get("name", ""),
                dex_id=item.get("dexId", "dex"),
                base_symbol=base_token.get("symbol"),
                quote_symbol=quote_token.get("symbol"),
                price_usd=price_usd,
                liquidity_usd=liq_usd,
                fdv_usd=item.get("fdv"),
                market_cap_usd=item.get("marketCap"),
                volume_24h_usd=vol_usd,
                txns_24h_buys=buys,
                txns_24h_sells=sells,
                price_change_1h=float(p1h) if p1h is not None else None,
                price_change_24h=float(p24h) if p24h is not None else None,
                pair_created_at_ms=item.get("pairCreatedAt"),
                state=TokenState.DISCOVERED
            )
        except Exception:
            return None
