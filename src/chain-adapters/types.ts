export interface BlockchainInfo {
  chain: string;
  blocks: number;
  bestBlockHash: string;
  difficulty: number;
  medianTime: number;
  verificationProgress: number;
  initialBlockDownload: boolean;
  chainWork: string;
}

export interface Block {
  hash: string;
  height: number;
  time: number;
  medianTime: number;
  nTx: number;
  tx: string[];
  previousBlockHash?: string;
  nextBlockHash?: string;
  confirmations: number;
  size: number;
  weight: number;
  version: number;
  difficulty: number;
}

export interface TransactionStatus {
  txHash: string;
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number;
  inMempool: boolean;
}

export interface AddressBalance {
  address: string;
  confirmed: string;       // satoshi as string
  unconfirmed: string;     // satoshi as string
  total: string;           // satoshi as string
}

export interface Utxo {
  txHash: string;
  vout: number;
  address: string;
  amount: string;          // satoshi as string
  scriptPubKey: string;
  confirmations: number;
  height: number | null;
}

export interface FeeEstimate {
  targetBlocks: number;
  feeRate: number;         // sat/vbyte
  mode: string;            // 'economical' | 'conservative'
}

export interface MempoolAcceptResult {
  txid: string;
  allowed: boolean;
  rejectReason?: string;
  vsize?: number;
  fees?: {
    base: number;
  };
}

export interface IChainAdapter {
  chain: string;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hashOrHeight: string | number): Promise<Block>;
  getRawTransaction(txHash: string, verbose?: boolean): Promise<any>;
  getRawMempool(): Promise<string[]>;
  getTransactionStatus(txHash: string): Promise<TransactionStatus>;
  getAddressBalance(address: string, tenantId: string): Promise<AddressBalance>;
  getUtxosForAddress(address: string, minConfirmations: number, tenantId: string): Promise<Utxo[]>;
  estimateSmartFee(targetBlocks: number): Promise<FeeEstimate>;
  testMempoolAccept(rawTx: string): Promise<MempoolAcceptResult>;
  sendRawTransaction(rawTx: string): Promise<string>;
  decodeRawTransaction(rawTx: string): Promise<any>;
  decodePsbt(psbt: string): Promise<any>;
  walletCreateFundedPsbt(inputs: any[], outputs: any[], options?: any): Promise<any>;
  finalizePsbt(psbt: string): Promise<any>;
  isValidAddress(address: string): boolean;
}
