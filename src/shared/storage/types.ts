export interface Lock {
  release(): Promise<void>;
}

/** 読み取りだけできるデータ源（Web は HTTP、バッチはストレージ） */
export interface ReadableStore {
  /** 存在しなければ null */
  getText(key: string): Promise<string | null>;
}

export interface Storage extends ReadableStore {
  /** キー単位で丸ごと置き換える（途中状態を読ませない） */
  putText(key: string, text: string): Promise<void>;
  /** 多重実行防止用の排他ロック。取得できなければ null */
  tryLock(key: string, ttlSeconds: number): Promise<Lock | null>;
}
