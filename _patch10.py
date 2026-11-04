import pathlib

p = pathlib.Path('src/protocol.ts')
s = p.read_text(encoding='utf-8')

anchor = "export function stripResidualDsml(text: string): string {"
assert s.count(anchor) == 1

fn = '''/**
 * 剥掉**宿主/站点自己的标记块**（`<ds_safety>…</ds_safety>` 这一类）。
 *
 * 2026-11-04 用户实测：真机上正文里冒出
 *   `<ds_safety>…[判定]…[规则无</ds_safety>Safe`
 * —— 那是网页端注入的**安全分类**，模型把它当正文吐了出来。旧逻辑只剥 DSML，
 * 对它一无所知 ⇒ 用户看到一段乱码，而且这一轮没有工具调用也没有正常回答（界面就"停下来"了）。
 *
 * 判据放宽到 `ds_*` 家族：这类标签是宿主的内部产物，**任何情况下都不该出现在回答里**。
 */
function stripHostMarkers(text: string): string {
  if (!text || !/ds_[a-z]/i.test(text)) return text
  let out = text
  // 成对块（可能未闭合到段尾）
  out = out.replace(/<ds_[a-z0-9_]+\\b[^>]*>[\\s\\S]*?<\\/ds_[a-z0-9_]+>/gi, '')
  out = out.replace(/<ds_[a-z0-9_]+\\b[^>]*>[\\s\\S]*$/i, '')
  // 落单的开关标签 + 紧跟的 `Safe` 尾巴（站点在分类结果后面还会补这个词）
  out = out.replace(/<\\/?ds_[a-z0-9_]+\\b[^>]*>/gi, '')
  out = out.replace(/(^|\\n)[ \\t]*Safe[ \\t]*(?=\\n|$)/g, '$1')
  return out
}

export function stripResidualDsml(text: string): string {'''

s = s.replace(anchor, fn)

old_impl = """  return stripNamelessDsmlFragments(stripDegenerateMarkup(cutDsmlMarkup(text)))
}"""
new_impl = """  // 顺序：DSML（成对块 + 残片）→ 宿主的 ds_* 标记块 → 退化标记
  return stripHostMarkers(stripNamelessDsmlFragments(stripDegenerateMarkup(cutDsmlMarkup(text))))
}"""
assert s.count(old_impl) == 1
s = s.replace(old_impl, new_impl)

p.write_text(s, encoding='utf-8', newline='')
print('written')
