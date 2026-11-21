export interface Lock {
  release(): Promise<void>;
}

export interface Storage {
  /** 存在しなければ null */
  getText(key: string): Promise<string | null>;
  /** キー単位で丸ごと置き換える（途中状態を読ませない） */
  putText(key: string, text: string): Promise<void>;
  /** 多重実行防止用の排他ロック。取得できなければ null */
  tryLock(key: string, ttlSeconds: number): Promise<Lock | null>;
}
