/** Store the pixels displayed by an img element as a local PNG. */
export async function downloadElementImage(source: string): Promise<Blob> {
  let url: URL;
  try { url = new URL(source); }
  catch { throw Error("图片地址无效，请重新选择图片。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw Error("暂不支持保存 blob 或 data 地址的图片。");
  const response = await fetch(url.href, { credentials: "include" });
  if (!response.ok) throw Error(`图片下载失败（HTTP ${response.status}），请稍后重试。`);
  const length = Number(response.headers.get("content-length"));
  if (length > 30_000_000) throw Error("图片超过 30 MB，暂不能保存。");
  const sourceBlob = await response.blob();
  if (sourceBlob.size > 30_000_000) throw Error("图片超过 30 MB，暂不能保存。");
  if (!sourceBlob.type.startsWith("image/")) throw Error("图片地址没有返回图片文件。");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(sourceBlob); }
  catch { throw Error("无法解码所选图片，请检查图片地址后重试。"); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000 ||
        bitmap.width > 16384 || bitmap.height > 16384)
      throw Error("图片尺寸过大，暂不能保存。");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw Error("无法创建图片画布。");
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally { bitmap.close(); }
}
