import { Connection, Keypair, PublicKey, VersionedTransaction, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';

export interface LiveBuyParams {
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress?: string;
  tradeAmountSol: number;
  tradeAmountUsd: number;
  maxSlippageBps?: number;
  priorityFeeLevel?: 'standard' | 'high' | 'ultra';
  onStepProgress?: (step: string, detail?: string) => void;
}

export interface LiveSellParams {
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress?: string;
  tokenQuantity: number;
  tokenDecimals?: number;
  maxSlippageBps?: number;
  priorityFeeLevel?: 'standard' | 'high' | 'ultra';
  onStepProgress?: (step: string, detail?: string) => void;
}

export interface LiveTradeResult {
  success: boolean;
  signature?: string;
  explorerUrl?: string;
  actualAmountIn?: number;
  actualAmountOut?: number;
  actualEffectivePriceUsd?: number;
  dexFeeUsd?: number;
  gasCostUsd?: number;
  priorityFeeUsd?: number;
  totalFeesUsd?: number;
  error?: string;
  timestamp: number;
  executionDurationMs: number;
}

// Global In-Memory Trading Keypair (Server-Side Only, Never Exposing Secret Key)
let activeTradingKeypair: Keypair | null = null;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Primary & Fallback Solana RPC Endpoints
export const SOLANA_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.publicnode.com',
];

let currentRpcIndex = 0;

export function getSolanaConnection(): Connection {
  const endpoint = SOLANA_RPC_ENDPOINTS[currentRpcIndex] || SOLANA_RPC_ENDPOINTS[0];
  return new Connection(endpoint, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000,
  });
}

export function rotateSolanaRpc(): Connection {
  currentRpcIndex = (currentRpcIndex + 1) % SOLANA_RPC_ENDPOINTS.length;
  console.log(`[RPC_ROTATION] Switched Solana RPC to: ${SOLANA_RPC_ENDPOINTS[currentRpcIndex]}`);
  return getSolanaConnection();
}

/**
 * Configure Server Trading Keypair securely from Base58 string, JSON byte array, or Hex.
 */
export function setTradingKeypair(secretKeyInput: string): { success: boolean; address?: string; error?: string } {
  if (!secretKeyInput || typeof secretKeyInput !== 'string') {
    return { success: false, error: 'Empty or invalid secret key input' };
  }

  const trimmed = secretKeyInput.trim();
  try {
    let keyBytes: Uint8Array;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // JSON byte array format [123, 45, ...]
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
        return { success: false, error: 'JSON secret key must contain 32 or 64 bytes' };
      }
      keyBytes = Uint8Array.from(parsed);
    } else {
      // Base58 encoded secret key
      keyBytes = bs58.decode(trimmed);
    }

    if (keyBytes.length === 64) {
      activeTradingKeypair = Keypair.fromSecretKey(keyBytes);
    } else if (keyBytes.length === 32) {
      activeTradingKeypair = Keypair.fromSeed(keyBytes);
    } else {
      return { success: false, error: `Invalid secret key byte length (${keyBytes.length}). Expected 32 or 64 bytes.` };
    }

    const pubkey = activeTradingKeypair.publicKey.toBase58();
    console.log(`[SECURITY] Server Trading Keypair loaded successfully: ${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`);
    return { success: true, address: pubkey };
  } catch (err: any) {
    return { success: false, error: `Failed to decode secret key: ${err.message}` };
  }
}

/**
 * Clear server keypair from memory
 */
export function clearTradingKeypair(): void {
  activeTradingKeypair = null;
}

export function getTradingKeypair(): Keypair | null {
  return activeTradingKeypair;
}

export function getTradingPublicKey(): string | null {
  return activeTradingKeypair ? activeTradingKeypair.publicKey.toBase58() : null;
}

export async function getTradingSignerStatus(): Promise<{
  configured: boolean;
  address: string | null;
  network: string;
  balanceSol: number;
  balanceUsd: number;
  readyForLiveTrading: boolean;
}> {
  if (!activeTradingKeypair) {
    return {
      configured: false,
      address: null,
      network: 'mainnet-beta',
      balanceSol: 0,
      balanceUsd: 0,
      readyForLiveTrading: false,
    };
  }

  const pubkey = activeTradingKeypair.publicKey;
  let balanceSol = 0;
  let balanceUsd = 0;

  try {
    const conn = getSolanaConnection();
    const lamports = await conn.getBalance(pubkey);
    balanceSol = lamports / 1e9;

    // Fetch SOL price
    try {
      const pResp = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(3000) });
      if (pResp.ok) {
        const pData = await pResp.json();
        const solUsd = parseFloat(pData.pairs?.[0]?.priceUsd || '145');
        balanceUsd = balanceSol * solUsd;
      }
    } catch (_) {
      balanceUsd = balanceSol * 145.0;
    }
  } catch (err) {
    console.warn('Could not fetch balance for trading keypair:', err);
  }

  return {
    configured: true,
    address: pubkey.toBase58(),
    network: 'mainnet-beta',
    balanceSol,
    balanceUsd,
    readyForLiveTrading: balanceSol >= 0.01,
  };
}

/**
 * Fetch real-time Jupiter Swap Quote
 */
export async function fetchJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamportsOrUnits: number,
  slippageBps: number = 100
): Promise<any> {
  const qs = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountLamportsOrUnits)}&slippageBps=${slippageBps}&swapMode=ExactIn`;
  const endpoints = [
    `https://lite-api.jup.ag/swap/v1/quote?${qs}`,
    `https://api.jup.ag/swap/v1/quote?${qs}`,
  ];

  let lastErr = 'Jupiter Quote API unreachable';
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        lastErr = `Jupiter Quote API returned ${res.status}: ${await res.text()}`;
        continue;
      }
      const quote = await res.json();
      if (!quote || !quote.outAmount) {
        lastErr = 'No executable route found for this swap pair.';
        continue;
      }
      return quote;
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr);
}

/**
 * Build Jupiter Versioned Swap Transaction
 */
export async function buildJupiterSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
  priorityFeeLevel: 'standard' | 'high' | 'ultra' = 'standard'
): Promise<string> {
  const feeMap = {
    standard: 50000,
    high: 250000,
    ultra: 1000000,
  };

  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: feeMap[priorityFeeLevel] || 'auto',
  };

  const endpoints = [
    'https://lite-api.jup.ag/swap/v1/swap',
    'https://api.jup.ag/swap/v1/swap',
  ];

  let lastErr = 'Jupiter Swap API unreachable';
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        lastErr = `Jupiter Swap Build API returned ${res.status}: ${await res.text()}`;
        continue;
      }
      const data = await res.json();
      if (!data || !data.swapTransaction) {
        lastErr = 'Jupiter Swap API did not return a valid serialized transaction';
        continue;
      }
      return data.swapTransaction;
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr);
}

/**
 * Confirm and verify Solana transaction on-chain
 */
export async function confirmAndVerifySolanaTransaction(
  signature: string,
  connection: Connection,
  targetMint?: string,
  userPubkey?: string
): Promise<{
  confirmed: boolean;
  actualTokensReceived?: number;
  actualSolSpent?: number;
  actualSolReceived?: number;
  feeLamports?: number;
  error?: string;
}> {
  const startTime = Date.now();
  let confirmed = false;

  // 1. Poll for confirmation
  while (Date.now() - startTime < 35000) {
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (status && status.value) {
        if (status.value.err) {
          return { confirmed: false, error: `On-chain execution failed: ${JSON.stringify(status.value.err)}` };
        }
        if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
          confirmed = true;
          break;
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!confirmed) {
    return { confirmed: false, error: 'Transaction confirmation timed out after 35 seconds' };
  }

  // 2. Fetch parsed transaction receipt to determine exact on-chain balance deltas
  let actualTokensReceived: number | undefined;
  let actualSolSpent: number | undefined;
  let actualSolReceived: number | undefined;
  let feeLamports: number | undefined;

  try {
    const parsedTx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (parsedTx && parsedTx.meta) {
      feeLamports = parsedTx.meta.fee;

      if (userPubkey) {
        // Inspect SOL pre/post balances
        const accountKeys = parsedTx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey.toBase58()));
        const userIdx = accountKeys.indexOf(userPubkey);
        if (userIdx !== -1) {
          const preLamports = parsedTx.meta.preBalances[userIdx] || 0;
          const postLamports = parsedTx.meta.postBalances[userIdx] || 0;
          const diffLamports = preLamports - postLamports; // positive = spent, negative = received

          if (diffLamports > 0) {
            actualSolSpent = (diffLamports - (feeLamports || 0)) / 1e9;
          } else {
            actualSolReceived = Math.abs(diffLamports) / 1e9;
          }
        }

        // Inspect SPL Token pre/post balances for target mint
        if (targetMint) {
          const preTokenBal = parsedTx.meta.preTokenBalances?.find(
            b => b.owner === userPubkey && b.mint === targetMint
          );
          const postTokenBal = parsedTx.meta.postTokenBalances?.find(
            b => b.owner === userPubkey && b.mint === targetMint
          );

          const preAmount = preTokenBal?.uiTokenAmount?.uiAmount || 0;
          const postAmount = postTokenBal?.uiTokenAmount?.uiAmount || 0;
          const deltaToken = postAmount - preAmount;

          if (deltaToken > 0) {
            actualTokensReceived = deltaToken;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not parse post-trade transaction details:', err);
  }

  return {
    confirmed: true,
    actualTokensReceived,
    actualSolSpent,
    actualSolReceived,
    feeLamports,
  };
}

/**
 * Execute a REAL Live Solana BUY Order
 */
export async function executeLiveSolanaBuy(params: LiveBuyParams): Promise<LiveTradeResult> {
  const start = Date.now();
  const notify = (step: string, detail?: string) => {
    if (params.onStepProgress) params.onStepProgress(step, detail);
  };

  if (!activeTradingKeypair) {
    return {
      success: false,
      error: 'Cannot execute Live BUY: No server-side trading keypair configured. Please configure your Solana trading wallet in Settings / Wallets.',
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }

  const userPubkey = activeTradingKeypair.publicKey.toBase58();
  const conn = getSolanaConnection();

  try {
    notify('VERIFYING_WALLET', `Validating on-chain SOL balance for ${userPubkey.slice(0, 6)}...`);
    const balanceLamports = await conn.getBalance(activeTradingKeypair.publicKey);
    const availableSol = balanceLamports / 1e9;

    if (availableSol < params.tradeAmountSol + 0.008) {
      return {
        success: false,
        error: `Insufficient SOL balance (${availableSol.toFixed(4)} SOL available). Required: ${(params.tradeAmountSol + 0.008).toFixed(4)} SOL (Trade + Gas Reserve).`,
        timestamp: Date.now(),
        executionDurationMs: Date.now() - start,
      };
    }

    // 1. Fetch live swap quote from Jupiter
    notify('FETCHING_QUOTE', `Obtaining executable route for ${params.tradeAmountSol} SOL -> ${params.tokenSymbol}...`);
    const amountLamports = Math.floor(params.tradeAmountSol * 1e9);
    const quote = await fetchJupiterQuote(
      WSOL_MINT,
      params.tokenAddress,
      amountLamports,
      params.maxSlippageBps || 100
    );

    const estTokensOut = parseFloat(quote.outAmount) / Math.pow(10, quote.outAmountDecimals || 6);
    notify('BUILDING_TRANSACTION', `Building swap transaction (Route: ${quote.routePlan?.map((r: any) => r.swapInfo?.label || 'DEX').join(' -> ')})...`);

    // 2. Build swap transaction
    const base64Tx = await buildJupiterSwapTransaction(quote, userPubkey, params.priorityFeeLevel || 'standard');

    // 3. Sign transaction locally using server trading keypair
    notify('SIGNING_TRANSACTION', `Signing versioned transaction with trading keypair ${userPubkey.slice(0, 4)}...`);
    const txBuf = Buffer.from(base64Tx, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);
    versionedTx.sign([activeTradingKeypair]);

    // 4. Broadcast raw transaction
    notify('BROADCASTING', 'Broadcasting signed transaction to Solana Mainnet RPC cluster...');
    const rawTx = versionedTx.serialize();
    const signature = await conn.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    notify('WAITING_CONFIRMATION', `Confirming transaction signature: ${signature.slice(0, 8)}...`);

    // 5. Confirm on-chain and retrieve filled metrics
    const verifyResult = await confirmAndVerifySolanaTransaction(
      signature,
      conn,
      params.tokenAddress,
      userPubkey
    );

    if (!verifyResult.confirmed) {
      return {
        success: false,
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        error: verifyResult.error || 'Transaction failed during on-chain confirmation.',
        timestamp: Date.now(),
        executionDurationMs: Date.now() - start,
      };
    }

    const actualTokens = verifyResult.actualTokensReceived || estTokensOut;
    const actualSolSpent = verifyResult.actualSolSpent || params.tradeAmountSol;
    const effectivePriceUsd = actualTokens > 0 ? (params.tradeAmountUsd / actualTokens) : (params.tradeAmountUsd / estTokensOut);

    notify('BUY_CONFIRMED', `Successfully bought ${actualTokens.toFixed(2)} ${params.tokenSymbol} @ $${effectivePriceUsd.toFixed(8)}!`);

    return {
      success: true,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      actualAmountIn: actualSolSpent,
      actualAmountOut: actualTokens,
      actualEffectivePriceUsd: effectivePriceUsd,
      gasCostUsd: ((verifyResult.feeLamports || 5000) / 1e9) * 145.0,
      totalFeesUsd: ((verifyResult.feeLamports || 5000) / 1e9) * 145.0,
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Live BUY execution failed: ${err.message}`,
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }
}

/**
 * Execute a REAL Live Solana SELL Order
 */
export async function executeLiveSolanaSell(params: LiveSellParams): Promise<LiveTradeResult> {
  const start = Date.now();
  const notify = (step: string, detail?: string) => {
    if (params.onStepProgress) params.onStepProgress(step, detail);
  };

  if (!activeTradingKeypair) {
    return {
      success: false,
      error: 'Cannot execute Live SELL: No server-side trading keypair configured.',
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }

  const userPubkey = activeTradingKeypair.publicKey.toBase58();
  const conn = getSolanaConnection();

  try {
    notify('FETCHING_TOKEN_BALANCE', `Verifying token account for ${params.tokenSymbol}...`);
    const decimals = params.tokenDecimals || 6;
    const rawAmount = Math.floor(params.tokenQuantity * Math.pow(10, decimals));

    if (rawAmount <= 0) {
      return {
        success: false,
        error: `Invalid token quantity (${params.tokenQuantity}) for selling.`,
        timestamp: Date.now(),
        executionDurationMs: Date.now() - start,
      };
    }

    // 1. Fetch SELL Quote from Jupiter (Token -> WSOL)
    notify('FETCHING_QUOTE', `Obtaining exit quote for ${params.tokenQuantity.toFixed(2)} ${params.tokenSymbol} -> SOL...`);
    const quote = await fetchJupiterQuote(
      params.tokenAddress,
      WSOL_MINT,
      rawAmount,
      params.maxSlippageBps || 150
    );

    const estSolReceived = parseFloat(quote.outAmount) / 1e9;
    notify('BUILDING_TRANSACTION', `Building exit transaction for ${estSolReceived.toFixed(4)} SOL proceeds...`);

    // 2. Build swap transaction
    const base64Tx = await buildJupiterSwapTransaction(quote, userPubkey, params.priorityFeeLevel || 'high');

    // 3. Sign transaction locally
    notify('SIGNING_TRANSACTION', 'Signing exit transaction with trading keypair...');
    const txBuf = Buffer.from(base64Tx, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);
    versionedTx.sign([activeTradingKeypair]);

    // 4. Broadcast
    notify('BROADCASTING', 'Broadcasting SELL transaction to Solana cluster...');
    const rawTx = versionedTx.serialize();
    const signature = await conn.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    notify('WAITING_CONFIRMATION', `Confirming SELL signature: ${signature.slice(0, 8)}...`);

    // 5. Confirm on blockchain
    const verifyResult = await confirmAndVerifySolanaTransaction(
      signature,
      conn,
      params.tokenAddress,
      userPubkey
    );

    if (!verifyResult.confirmed) {
      return {
        success: false,
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        error: verifyResult.error || 'SELL transaction failed during on-chain confirmation.',
        timestamp: Date.now(),
        executionDurationMs: Date.now() - start,
      };
    }

    const actualSolReceived = verifyResult.actualSolReceived || estSolReceived;
    const exitPriceUsd = (actualSolReceived * 145.0) / params.tokenQuantity;

    notify('SELL_CONFIRMED', `Successfully sold ${params.tokenQuantity.toFixed(2)} ${params.tokenSymbol} for ${actualSolReceived.toFixed(4)} SOL!`);

    return {
      success: true,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      actualAmountIn: params.tokenQuantity,
      actualAmountOut: actualSolReceived,
      actualEffectivePriceUsd: exitPriceUsd,
      gasCostUsd: ((verifyResult.feeLamports || 5000) / 1e9) * 145.0,
      totalFeesUsd: ((verifyResult.feeLamports || 5000) / 1e9) * 145.0,
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Live SELL execution failed: ${err.message}`,
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }
}

/**
 * Prepare unsigned Jupiter BUY transaction for browser wallet (Phantom / Solflare) signing
 */
export async function prepareLiveBuyTransaction(params: LiveBuyParams & { userPublicKey: string }): Promise<{
  success: boolean;
  base64Tx?: string;
  estTokensOut?: number;
  error?: string;
}> {
  try {
    const conn = getSolanaConnection();
    const pubkey = new PublicKey(params.userPublicKey);
    const balanceLamports = await conn.getBalance(pubkey);
    const availableSol = balanceLamports / 1e9;
    if (availableSol < params.tradeAmountSol + 0.005) {
      return {
        success: false,
        error: `Insufficient SOL balance (${availableSol.toFixed(4)} SOL). Needed ${(params.tradeAmountSol + 0.005).toFixed(4)} SOL.`,
      };
    }

    const amountLamports = Math.floor(params.tradeAmountSol * 1e9);
    const quote = await fetchJupiterQuote(
      WSOL_MINT,
      params.tokenAddress,
      amountLamports,
      params.maxSlippageBps || 150
    );
    const estTokensOut = parseFloat(quote.outAmount) / Math.pow(10, quote.outAmountDecimals || 6);
    const base64Tx = await buildJupiterSwapTransaction(
      quote,
      params.userPublicKey,
      params.priorityFeeLevel || 'standard'
    );
    return { success: true, base64Tx, estTokensOut };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to prepare Jupiter buy tx' };
  }
}

/**
 * Prepare unsigned Jupiter SELL transaction for browser wallet (Phantom / Solflare) signing
 */
export async function prepareLiveSellTransaction(params: LiveSellParams & { userPublicKey: string }): Promise<{
  success: boolean;
  base64Tx?: string;
  estSolReceived?: number;
  error?: string;
}> {
  try {
    const decimals = params.tokenDecimals || 6;
    const rawAmount = Math.floor(params.tokenQuantity * Math.pow(10, decimals));
    if (rawAmount <= 0) {
      return { success: false, error: 'Invalid token quantity for selling' };
    }
    const quote = await fetchJupiterQuote(
      params.tokenAddress,
      WSOL_MINT,
      rawAmount,
      params.maxSlippageBps || 200
    );
    const estSolReceived = parseFloat(quote.outAmount) / 1e9;
    const base64Tx = await buildJupiterSwapTransaction(
      quote,
      params.userPublicKey,
      params.priorityFeeLevel || 'high'
    );
    return { success: true, base64Tx, estSolReceived };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to prepare Jupiter sell tx' };
  }
}

/**
 * Confirm & verify a transaction signed and broadcast by the browser Phantom wallet
 */
export async function finalizeBrowserSignedTransaction(params: {
  signature: string;
  targetMint: string;
  userPubkey: string;
  isBuy: boolean;
  tradeAmountUsd?: number;
  tradeAmountSol?: number;
  estTokensOut?: number;
  estSolReceived?: number;
  tokenQuantity?: number;
  solPriceUsd?: number;
}): Promise<LiveTradeResult> {
  const start = Date.now();
  const conn = getSolanaConnection();
  const verifyResult = await confirmAndVerifySolanaTransaction(
    params.signature,
    conn,
    params.targetMint,
    params.userPubkey
  );
  if (!verifyResult.confirmed) {
    return {
      success: false,
      signature: params.signature,
      explorerUrl: `https://solscan.io/tx/${params.signature}`,
      error: verifyResult.error || 'Transaction confirmation failed.',
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }
  const solUsd = params.solPriceUsd || 145;
  if (params.isBuy) {
    const actualTokens = verifyResult.actualTokensReceived || params.estTokensOut || 1;
    const actualSol = verifyResult.actualSolSpent || params.tradeAmountSol || 0;
    const usd = params.tradeAmountUsd || actualSol * solUsd;
    return {
      success: true,
      signature: params.signature,
      explorerUrl: `https://solscan.io/tx/${params.signature}`,
      actualAmountIn: actualSol,
      actualAmountOut: actualTokens,
      actualEffectivePriceUsd: actualTokens > 0 ? usd / actualTokens : 0,
      gasCostUsd: ((verifyResult.feeLamports || 5000) / 1e9) * solUsd,
      totalFeesUsd: ((verifyResult.feeLamports || 5000) / 1e9) * solUsd,
      timestamp: Date.now(),
      executionDurationMs: Date.now() - start,
    };
  }
  const actualSol = verifyResult.actualSolReceived || params.estSolReceived || 0;
  const qty = params.tokenQuantity || 1;
  return {
    success: true,
    signature: params.signature,
    explorerUrl: `https://solscan.io/tx/${params.signature}`,
    actualAmountIn: qty,
    actualAmountOut: actualSol,
    actualEffectivePriceUsd: qty > 0 ? (actualSol * solUsd) / qty : 0,
    gasCostUsd: ((verifyResult.feeLamports || 5000) / 1e9) * solUsd,
    totalFeesUsd: ((verifyResult.feeLamports || 5000) / 1e9) * solUsd,
    timestamp: Date.now(),
    executionDurationMs: Date.now() - start,
  };
}
