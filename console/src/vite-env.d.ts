/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_READ_URL?: string;
  readonly VITE_RPC_UPSTREAM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
