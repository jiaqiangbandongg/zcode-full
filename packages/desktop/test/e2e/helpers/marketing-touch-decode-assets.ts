// 文件头通过服务端类型检查，正文刻意损坏，验证浏览器解码失败而非下载失败。
export const marketingTouchDecodeAssets = {
  brokenPng: {
    path: "/marketing-assets/broken-decode.png",
    bytes: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("E2E broken PNG")]),
    type: "image/png",
  },
  brokenMp4: {
    path: "/marketing-assets/broken-decode.mp4",
    bytes: Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex"),
    type: "video/mp4",
  },
};
