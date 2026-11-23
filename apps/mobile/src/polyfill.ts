import * as Crypto from 'expo-crypto';

/**
 * Hermes 没有 Web Crypto。
 *
 * `@grid/core` 的 ULID 生成直接调用 `crypto.getRandomValues(bytes)` —— 浏览器和 Node
 * 都有这个全局对象，React Native（Hermes 引擎）没有。于是裸引用 `crypto` 会抛
 * `ReferenceError: Property 'crypto' doesn't exist`。
 *
 * 更麻烦的是它抛在 `ensureDeviceId()` 里，那个位置在 AppProvider 启动序列中，
 * 表现是"打开后一直转圈/白屏、控制台一行红字"，看不出跟 id 生成有关系。
 *
 * 这个 polyfill 必须在**任何 ulid() 调用之前**执行，所以在 app/_layout.tsx 的第一行
 * 被 import —— 那是最早能跑到的用户代码。
 *
 * 选择补在宿主而不是改 core：Web 端的 ULID 应该继续用浏览器的 CSPRNG，
 * 不能因为移动端缺 API 就把共享层降级成 Math.random。
 */
interface CryptoLike {
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

const scope = globalThis as unknown as { crypto?: CryptoLike };

if (typeof scope.crypto?.getRandomValues !== 'function') {
  const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    // 用 buffer/byteOffset 包一层视图而不是直接 new Uint8Array(array)：
    // 传进来的可能是 Uint32Array，按元素浅拷贝会得到长度错误
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    view.set(Crypto.getRandomBytes(view.length));
    return array;
  };

  // defineProperty 而不是赋值：RN 某些版本上 crypto 是只读访问器，
  // 直接赋值在严格模式下会抛 TypeError，而这里必须保证一定生效
  Object.defineProperty(scope, 'crypto', {
    value: { ...(scope.crypto ?? {}), getRandomValues },
    configurable: true,
    writable: true,
  });
}
