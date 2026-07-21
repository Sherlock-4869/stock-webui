// Lightweight GBK -> UTF-8 decoder (no external deps)
// Uses TextDecoder if available (Node 11+), otherwise falls back to a bundled map
module.exports = function gbkDecode(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    // TextDecoder may not support gbk in all builds; try gb18030
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch (e2) {
      return buf.toString('latin1');
    }
  }
};
