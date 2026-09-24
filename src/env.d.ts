/// <reference types="vite/client" />

declare module "*?worker" {
  const workerCtor: {
    new (options?: { name?: string }): Worker;
  };
  export default workerCtor;
}