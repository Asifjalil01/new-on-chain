"""Base and concrete ChainAdapters for all 8 supported blockchains."""

import re
from abc import ABC, abstractmethod
from typing import Dict, Optional, Any


class ChainAdapter(ABC):
    """Abstract base class for blockchain network adapters."""

    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @property
    @abstractmethod
    def native_symbol(self) -> str:
        pass

    @property
    @abstractmethod
    def chain_id(self) -> Optional[int]:
        pass

    @property
    @abstractmethod
    def is_evm(self) -> bool:
        pass

    @property
    def is_solana(self) -> bool:
        return not self.is_evm

    @abstractmethod
    def validate_address(self, address: str) -> bool:
        pass

    @abstractmethod
    def normalize_address(self, address: str) -> str:
        pass

    @abstractmethod
    def explorer_tx_url(self, tx_hash: str) -> str:
        pass

    @abstractmethod
    def explorer_token_url(self, token_address: str) -> str:
        pass

    @abstractmethod
    def get_default_dex(self) -> str:
        pass


class EVMBaseAdapter(ChainAdapter):
    """Shared base class for all EVM-compatible networks."""

    def validate_address(self, address: str) -> bool:
        if not address or not isinstance(address, str):
            return False
        return bool(re.match(r"^0x[a-fA-F0-9]{40}$", address.strip()))

    def normalize_address(self, address: str) -> str:
        if not self.validate_address(address):
            raise ValueError(f"Invalid EVM address: {address}")
        return address.strip().lower()

    @property
    def is_evm(self) -> bool:
        return True


class SolanaAdapter(ChainAdapter):
    @property
    def name(self) -> str:
        return "solana"

    @property
    def native_symbol(self) -> str:
        return "SOL"

    @property
    def chain_id(self) -> Optional[int]:
        return None

    @property
    def is_evm(self) -> bool:
        return False

    def validate_address(self, address: str) -> bool:
        if not address or not isinstance(address, str):
            return False
        # Base58 check (32 to 44 characters)
        return bool(re.match(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$", address.strip()))

    def normalize_address(self, address: str) -> str:
        if not self.validate_address(address):
            raise ValueError(f"Invalid Solana address: {address}")
        return address.strip()

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://solscan.io/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://solscan.io/token/{token_address}"

    def get_default_dex(self) -> str:
        return "raydium"


class EthereumAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "ethereum"

    @property
    def native_symbol(self) -> str:
        return "ETH"

    @property
    def chain_id(self) -> Optional[int]:
        return 1

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://etherscan.io/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://etherscan.io/token/{token_address}"

    def get_default_dex(self) -> str:
        return "uniswap"


class BSCAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "bsc"

    @property
    def native_symbol(self) -> str:
        return "BNB"

    @property
    def chain_id(self) -> Optional[int]:
        return 56

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://bscscan.com/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://bscscan.com/token/{token_address}"

    def get_default_dex(self) -> str:
        return "pancakeswap"


class BaseAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "base"

    @property
    def native_symbol(self) -> str:
        return "ETH"

    @property
    def chain_id(self) -> Optional[int]:
        return 8453

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://basescan.org/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://basescan.org/token/{token_address}"

    def get_default_dex(self) -> str:
        return "aerodrome"


class ArbitrumAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "arbitrum"

    @property
    def native_symbol(self) -> str:
        return "ETH"

    @property
    def chain_id(self) -> Optional[int]:
        return 42161

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://arbiscan.io/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://arbiscan.io/token/{token_address}"

    def get_default_dex(self) -> str:
        return "uniswap"


class PolygonAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "polygon"

    @property
    def native_symbol(self) -> str:
        return "POL"

    @property
    def chain_id(self) -> Optional[int]:
        return 137

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://polygonscan.com/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://polygonscan.com/token/{token_address}"

    def get_default_dex(self) -> str:
        return "quickswap"


class AvalancheAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "avalanche"

    @property
    def native_symbol(self) -> str:
        return "AVAX"

    @property
    def chain_id(self) -> Optional[int]:
        return 43114

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://snowtrace.io/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://snowtrace.io/token/{token_address}"

    def get_default_dex(self) -> str:
        return "traderjoe"


class OptimismAdapter(EVMBaseAdapter):
    @property
    def name(self) -> str:
        return "optimism"

    @property
    def native_symbol(self) -> str:
        return "ETH"

    @property
    def chain_id(self) -> Optional[int]:
        return 10

    def explorer_tx_url(self, tx_hash: str) -> str:
        return f"https://optimistic.etherscan.io/tx/{tx_hash}"

    def explorer_token_url(self, token_address: str) -> str:
        return f"https://optimistic.etherscan.io/token/{token_address}"

    def get_default_dex(self) -> str:
        return "velodrome"


class ChainRegistry:
    """Registry maintaining instances of all supported chain adapters."""

    def __init__(self):
        self._adapters: Dict[str, ChainAdapter] = {
            "solana": SolanaAdapter(),
            "ethereum": EthereumAdapter(),
            "bsc": BSCAdapter(),
            "base": BaseAdapter(),
            "arbitrum": ArbitrumAdapter(),
            "polygon": PolygonAdapter(),
            "avalanche": AvalancheAdapter(),
            "optimism": OptimismAdapter(),
        }

    def get_adapter(self, chain_name: str) -> ChainAdapter:
        from onchain_bot.config.settings import normalize_chain
        normalized = normalize_chain(chain_name)
        if normalized not in self._adapters:
            raise ValueError(f"Chain adapter not registered: {normalized}")
        return self._adapters[normalized]

    def list_chains(self) -> list[str]:
        return list(self._adapters.keys())
