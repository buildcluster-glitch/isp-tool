// ==UserScript==
// @name         山一見積 一括入力（その他商品情報）
// @namespace    kowa-kogyo.tools
// @version      1.7.2
// @description  修繕業者WEB(ISP)の見積登録ページに「一括入力」パネルを追加。積算シートの表をそのまま貼り付けて、見積情報＋備考情報＋負担情報へ一括投入（売価単価=見積単価/備考=室名+仕様/依頼元単価=請求単価/家主・契約者の負担%は負担区分から自動）。先頭の担当者ブロックから内容情報フォームへ担当社員・アンペア数も入力（登録は手動）。保存先フォルダのコピー（その他情報の添付用）。重ね貼り時の余り行クリア＆商品名の全タブ同期に対応。／【工事完了ページ】完了日（修繕完了日＋全商品の工事完了日）を一括入力＆登録まで（確定は手動）。
// @match        https://syuzen-yamaichi-j.i-vrdc.com/spodr/order/mitsumori_edit.asp*
// @match        https://syuzen-yamaichi-j.i-vrdc.com/spodr/repair_comp/repair_comp_edit.asp*
// @match        https://syuzen-yamaichi-j.i-vrdc.com/spodr/repair_comp/repair_list.asp*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/buildcluster-glitch/isp-tool/main/yamaichi-mitsumori-bulk.user.js
// @downloadURL  https://raw.githubusercontent.com/buildcluster-glitch/isp-tool/main/yamaichi-mitsumori-bulk.user.js
// ==/UserScript==
//
// ▼ 自動更新について
//   このファイルはGitHubリポジトリ(buildcluster-glitch/isp-tool)で配信されています。
//   内容を更新するときは、GitHub上の同名ファイルを差し替え、必ず @version を上げること。
//   各PCのTampermonkeyが定期的に @downloadURL を確認し、自動で最新版に更新します。
//   （手動で今すぐ確認: Tampermonkeyダッシュボード → 「最終更新」列 or 右クリック→更新確認）
//
// ▼ 対応している貼り付け形式
//   (1) 積算シートの表（推奨）… ヘッダー行を自動判別して列を割り当てます。
//       必要な列見出し: 商品項目 / 数量 / 単位 / 見積単価（無ければ 売価単価→請求単価）
//       ・売価単価には「見積単価」を採用（請求単価=マークアップ後は負担/請求側で使用）
//       ・余分な列（過失・備考・見積小計・請求小計 等）は無視
//   (2) 単純形式（フォールバック）… ヘッダーが無いとき 1行=「品名,単価,数量,単位」として読む
//
//   ※対応済み：見積情報（商品項目・数量・単位・売価単価=見積単価）＋備考情報（備考=室名+仕様）
//     ＋負担情報（依頼元単価=請求単価／家主・契約者の負担%を負担区分から自動）。
//     負担区分: 家主→家主100%/契約者0%、入居者(契約者/退去者)→家主0%/契約者100%。
//   ※内容情報：貼り付け先頭の「立会担当者/アンペア数/特記(備考)」ラベル行を読み、「内容情報を入力」ボタンで
//     内容フォームを開き 担当社員＝立会担当者、内容＝「※アンペア数 ○○A」＋特記 を入力。【登録ボタンは押さない】

(function () {
  'use strict';

  // 単位名 → 内部コード（ページのプルダウン値）。代用ルール込み。
  var UNIT = {
    '㎡': '1', 'm2': '1', '平米': '1', '帖': '2', '畳': '2', // 畳→帖
    '枚': '3', '面': '3',                                    // 面→枚
    'm': '4', 'ｍ': '4', '個': '5', '式': '6', '基': '7', '台': '8',
    '箇所': '9', 'ヶ所': '9', 'か所': '9', '本': '10', '坪': '11', '回': '12',
    'mm': '13', 'cm': '14', 'kw': '21', 'kW': '21', '秒': '22', 'L': '23', 'm3': '24'
  };

  function $$() { return window.jQuery; }

  // 現在の「その他商品情報」行インデックス（_0,_1...）を昇順で返す
  function rowIndexes() {
    var n = [];
    document.querySelectorAll('input').forEach(function (i) {
      var m = /^txtShnInfoSyohin_(\d+)$/.exec(i.name);
      if (m) n.push(parseInt(m[1], 10));
    });
    return n.sort(function (a, b) { return a - b; });
  }

  function setVal(name, val, fire) {
    var el = document.getElementsByName(name)[0];
    if (!el) return false;
    el.value = val;
    if (fire) {
      var $ = $$();
      if ($) { $(el).trigger('keyup').trigger('change').trigger('blur'); }
      else { ['keyup', 'change', 'blur'].forEach(function (ev) { el.dispatchEvent(new Event(ev, { bubbles: true })); }); }
    }
    return true;
  }

  // 貼り付けテキスト → 明細配列 [{name,tanka,qty,unit}]
  function parse(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    var rows = lines.map(function (l) {
      return (l.indexOf('\t') >= 0 ? l.split('\t') : l.split(',')).map(function (c) { return c.trim(); });
    });
    var out = [];
    // ヘッダー行（"商品項目"を含む行）を探す
    var hIdx = rows.findIndex(function (r) { return r.indexOf('商品項目') >= 0; });
    if (hIdx >= 0) {
      var H = rows[hIdx];
      var col = function (n) { return H.indexOf(n); };
      var cName = col('商品項目'), cQty = col('数量'), cUnit = col('単位');
      var cBiko = H.findIndex(function (c) { return c.indexOf('備考') >= 0; }); // 備考(室名+仕様)
      var cSeikyu = col('請求単価'), cFutan = col('負担区分');
      // 見積タブ売価単価＝見積単価（無ければ売価単価→請求単価）
      var cPrice = col('見積単価') >= 0 ? col('見積単価')
        : (col('売価単価') >= 0 ? col('売価単価') : col('請求単価'));
      for (var i = hIdx + 1; i < rows.length; i++) {
        var r = rows[i];
        var nm = cName >= 0 ? (r[cName] || '').trim() : '';
        if (!nm) continue;
        var tk = cPrice >= 0 ? (r[cPrice] || '').replace(/[^\d]/g, '') : '';
        var qt = cQty >= 0 ? (r[cQty] || '').replace(/[^\d.]/g, '') : '';
        var un = cUnit >= 0 ? (r[cUnit] || '').trim() : '';
        var bk = cBiko >= 0 ? (r[cBiko] || '').trim() : '';
        var sk = cSeikyu >= 0 ? (r[cSeikyu] || '').replace(/[^\d]/g, '') : '';
        var ft = cFutan >= 0 ? (r[cFutan] || '').trim() : '';
        out.push({ name: nm, tanka: tk || '0', qty: qt || '1', unit: un, biko: bk, seikyu: sk, futan: ft });
      }
      return out;
    }
    // フォールバック（ヘッダー無し: 品名 / 単価 / 数量 / 単位）
    lines.forEach(function (line) {
      var c = (line.indexOf('\t') >= 0 ? line.split('\t') : line.split(',')).map(function (x) { return x.trim(); });
      var nm = c[0] || '';
      var tk = (c[1] || '').replace(/[^\d]/g, '');
      if (!nm || !/\d/.test(tk)) return;
      out.push({ name: nm, tanka: tk, qty: (c[2] || '').replace(/[^\d.]/g, '') || '1', unit: c[3] || '', biko: '', seikyu: '', futan: '' });
    });
    return out;
  }

  // 先頭の「ラベル[Tab]値」ブロック（商品項目の表より前）から案件単位の情報を拾う
  function parseHeader(text) {
    var lines = text.split(/\r?\n/);
    var h = { tantou: '', ampere: '', tokki: '', savePath: '' };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf('商品項目') >= 0) break; // 明細表ヘッダーに到達したら終了
      var c = (ln.indexOf('\t') >= 0 ? ln.split('\t') : ln.split(',')).map(function (x) { return x.trim(); });
      if (c.length < 2 || !c[1]) continue;
      var label = c[0];
      if (/担当/.test(label)) h.tantou = c[1];
      else if (/アンペア/.test(label)) h.ampere = c[1];
      else if (/保存先|フォルダ/.test(label)) h.savePath = c[1];
      else if (/特記|備考/.test(label)) h.tokki = c[1];
    }
    return h;
  }

  // クリップボードへコピー（クリックハンドラ内で同期実行）
  function copyText(s) {
    try {
      var t = document.createElement('textarea');
      t.value = s; t.style.position = 'fixed'; t.style.left = '-9999px';
      document.body.appendChild(t); t.focus(); t.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(t);
      return ok;
    } catch (e) { return false; }
  }

  // 保存先ルート（各PCごとにブラウザへ保存。相対パスの前に付ける絶対パスの先頭）
  function getRoot() { try { return localStorage.getItem('kowaSavePathRoot') || ''; } catch (e) { return ''; } }
  function setRoot(v) { try { localStorage.setItem('kowaSavePathRoot', v || ''); } catch (e) { } }

  // 保存先フォルダをコピー（ルート＋相対パス＝フルパス。参照ダイアログのファイル名欄に貼付→Enterでフォルダへ）
  function copySavePath(text, statusEl) {
    var h = parseHeader(text);
    if (!h.savePath) {
      statusEl.style.color = '#c00';
      statusEl.textContent = '保存先フォルダの行が見つかりません（貼り付け先頭に「保存先フォルダ[Tab]パス」が必要）';
      return;
    }
    var root = getRoot();
    var rel = h.savePath.replace(/^[\\\/]+/, '');
    var full = root ? (root.replace(/[\\\/]+$/, '') + '\\' + rel) : rel;
    var done = function (ok) {
      statusEl.style.color = ok ? '#080' : '#c00';
      if (!ok) { statusEl.textContent = 'コピー失敗（手動でコピーを）: ' + full; return; }
      statusEl.textContent = '📋コピー → ' + full
        + (root ? '｜「参照」→ファイル名欄に貼付Enterでフォルダへ' : '｜※「保存先ルート」未設定＝相対パスのまま。下の欄にあなたのPCのルートを設定すると絶対パスになります');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(full).then(function () { done(true); }, function () { done(copyText(full)); });
    } else {
      done(copyText(full));
    }
  }

  // 内容情報タブ：「内容」フォームを開いて担当社員・内容を入力（登録は手動・押さない）
  function fillNaiyo(text, statusEl) {
    var $ = $$();
    var h = parseHeader(text);
    if (!h.tantou && !h.ampere && !h.tokki) {
      statusEl.style.color = '#c00';
      statusEl.textContent = '担当者・アンペア数等が貼り付けの先頭に見つかりません（立会担当者/アンペア数/特記 のラベル行）';
      return;
    }
    var naiyo = [];
    if (h.ampere) naiyo.push('※アンペア数 ' + h.ampere);
    if (h.tokki) naiyo.push(h.tokki);
    var naiyoStr = naiyo.join('\n');
    // 目標値をフィールドへ「再アサート」（登録ボタン btn_edit は絶対に押さない）
    var assert = function () {
      var shn = document.getElementById('txtShnName');
      var ta = document.getElementById('taNaiyo');
      var done = false;
      if (shn && shn.value !== h.tantou) { shn.value = h.tantou; if ($) $(shn).trigger('change'); }
      if (ta && ta.value !== naiyoStr) { ta.value = naiyoStr; if ($) $(ta).trigger('change'); }
      if (shn || ta) done = true;
      return done;
    };
    var finish = function () {
      if (document.getElementById('txtShnName') || document.getElementById('taNaiyo')) {
        statusEl.style.color = '#080';
        statusEl.textContent = '内容フォームに入力（担当社員=' + h.tantou + '）。確認して『登録』を押してください（登録は手動）。';
      } else {
        statusEl.style.color = '#c00';
        statusEl.textContent = '内容フォームを開けませんでした。内容情報タブで「内容」を押してから再度お試しください。';
      }
    };
    var ta0 = document.getElementById('taNaiyo');
    var opened = ta0 && ta0.getBoundingClientRect().height > 0;
    if (!opened) {
      var btn = [...document.querySelectorAll('img')].find(function (e) { return /btn_contents\.gif/.test(e.src || ''); });
      if (!btn) {
        statusEl.style.color = '#c00';
        statusEl.textContent = '「内容」ボタンが見つかりません（内容情報タブで手動で開いてください）';
        return;
      }
      if ($) $(btn).click(); else btn.click();
    }
    // フォームを開く際の非同期リセットに負けないよう、約2.6秒間 値を再アサートし続ける
    statusEl.style.color = '#555';
    statusEl.textContent = '内容フォームに入力中…';
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      assert();
      if (tries >= 18) { clearInterval(iv); finish(); }
    }, 150);
  }

  function run(text, statusEl) {
    var $ = $$();
    var items = parse(text);
    if (!items.length) { statusEl.style.color = '#c00'; statusEl.textContent = '読み取れる明細がありません（商品項目の列見出し or 品名,単価 を確認）'; return; }

    var _alert = window.alert, _confirm = window.confirm, dialogs = [];
    window.alert = function (m) { dialogs.push(m); };
    window.confirm = function (m) { dialogs.push(m); return true; };
    try {
      // 必要な行数を確保（足りなければ「追加」ボタン）
      var have = rowIndexes(), guard = 0;
      while (have.length < items.length && guard++ < 300) {
        if ($) { $('#btn_Add').click(); } else { document.getElementById('btn_Add').click(); }
        have = rowIndexes();
      }
      // have の全行を走査し、明細数まで埋め、余った既存行はクリア（重ね貼り・残り行のズレ防止）
      var unmatched = [], cleared = 0, unknownFutan = [];
      have.forEach(function (idx, i) {
        var unitSel = document.getElementsByName('slcShnInfoUntCd_' + idx)[0];
        if (i < items.length) {
          var it = items[i];
          // 商品項目：fireで負担(Syohin02)・備考(Syohin03)タブ側へ自動同期。念のため直接も設定
          setVal('txtShnInfoSyohin_' + idx, it.name, true);
          setVal('txtShnInfoSyohin02_' + idx, it.name, false);
          setVal('txtShnInfoSyohin03_' + idx, it.name, false);
          setVal('txtShnInfoGenkaTanka_' + idx, it.tanka, true);   // 見積タブ 売価単価＝見積単価
          setVal('txtShnInfoSuryo_' + idx, it.qty, true);
          setVal('txtShnInfoRemark_' + idx, it.biko || '', false); // 備考情報タブの備考（空なら空で上書き）
          if (unitSel) { unitSel.value = (it.unit && UNIT[it.unit]) ? UNIT[it.unit] : '0'; if ($) $(unitSel).trigger('change'); }
          if (it.unit && !UNIT[it.unit]) unmatched.push(it.unit);
          // 負担情報タブ：依頼元単価＝請求単価（無ければ見積単価）、負担%は負担区分から
          setVal('txtShnInfoJisyaSetteiTanka_' + idx, it.seikyu || it.tanka, true);
          var owner = /家主|オーナー/.test(it.futan);
          var tenant = /入居|契約|退去/.test(it.futan);
          setVal('txtShnInfoYnsFutanRate_' + idx, owner ? '100' : (tenant ? '0' : '100'), true);
          setVal('txtShnInfoKysFutanRate_' + idx, owner ? '0' : (tenant ? '100' : '0'), true);
          if (!owner && !tenant && it.futan) unknownFutan.push(it.futan);
        } else {
          ['txtShnInfoSyohin_', 'txtShnInfoSyohin02_', 'txtShnInfoSyohin03_', 'txtShnInfoRemark_'].forEach(function (p) { setVal(p + idx, '', false); });
          setVal('txtShnInfoGenkaTanka_' + idx, '', true);
          setVal('txtShnInfoSuryo_' + idx, '', false);
          setVal('txtShnInfoJisyaSetteiTanka_' + idx, '', true);
          setVal('txtShnInfoYnsFutanRate_' + idx, '0', true);
          setVal('txtShnInfoKysFutanRate_' + idx, '0', true);
          if (unitSel) { unitSel.value = '0'; if ($) $(unitSel).trigger('change'); }
          cleared++;
        }
      });
      var total = (document.getElementsByName('txtHchInfoMitsumoriTotalKingaku')[0] || {}).value || '';
      statusEl.style.color = '#080';
      var msg = items.length + '件入力（見積情報＋備考＋負担%）合計: ' + total + ' 円';
      if (cleared) msg += '｜余り' + cleared + '行クリア';
      if (unmatched.length) msg += '｜単位未対応(手動選択): ' + Array.from(new Set(unmatched)).join('・');
      if (unknownFutan.length) msg += '｜負担区分不明=家主扱い: ' + Array.from(new Set(unknownFutan)).join('・');
      statusEl.textContent = msg;
    } catch (e) {
      statusEl.style.color = '#c00';
      statusEl.textContent = 'エラー: ' + e.message;
    } finally {
      window.alert = _alert; window.confirm = _confirm;
    }
  }

  // ---- パネルUI ----
  function buildPanel() {
    if (document.getElementById('kowaBulkPanel')) return;
    var wrap = document.createElement('div');
    wrap.id = 'kowaBulkPanel';
    wrap.style.cssText = 'position:fixed;top:90px;right:16px;z-index:99999;width:340px;font:12px/1.5 "Meiryo",sans-serif;background:#fff;border:2px solid #2f5597;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    wrap.innerHTML =
      '<div id="kowaBulkHead" style="background:#2f5597;color:#fff;padding:7px 10px;font-weight:bold;border-radius:5px 5px 0 0;cursor:move;display:flex;justify-content:space-between;align-items:center;">'
      + '<span>📋 見積 一括入力</span><span id="kowaBulkMin" style="cursor:pointer;padding:0 6px;">－</span></div>'
      + '<div id="kowaBulkBody" style="padding:10px;">'
      + '<div style="color:#555;margin-bottom:5px;">積算シートの表を<b>ヘッダー行ごと</b>コピーして貼り付け → 入力実行。<br>'
      + '<b>見積情報</b>（売価単価=見積単価）・<b>備考情報</b>（室名+仕様）・<b>負担情報</b>（依頼元単価=請求単価／家主・契約者%）へ同時に一括投入します。</div>'
      + '<textarea id="kowaBulkInput" rows="8" style="width:100%;box-sizing:border-box;font:12px monospace;" placeholder="過失  商品項目  備考(室名+仕様)  数量  単位  負担区分  見積単価  見積小計  請求単価  請求小計&#10;（↑この表をヘッダーごとコピペ。タブ区切りでそのまま貼ればOK）"></textarea>'
      + '<div style="margin-top:6px;display:flex;gap:6px;">'
      + '<button id="kowaBulkRun" style="flex:1;background:#2f5597;color:#fff;border:0;border-radius:4px;padding:7px;font-weight:bold;cursor:pointer;">入力実行</button>'
      + '<button id="kowaBulkClear" style="background:#ddd;border:0;border-radius:4px;padding:7px 10px;cursor:pointer;">クリア</button>'
      + '</div>'
      + '<button id="kowaBulkNaiyo" style="width:100%;margin-top:6px;background:#0a7d3b;color:#fff;border:0;border-radius:4px;padding:7px;font-weight:bold;cursor:pointer;">内容情報を入力（担当者・アンペア数）</button>'
      + '<button id="kowaBulkPath" style="width:100%;margin-top:6px;background:#8a5a00;color:#fff;border:0;border-radius:4px;padding:7px;font-weight:bold;cursor:pointer;">📋 保存先フォルダをコピー（その他情報の添付用）</button>'
      + '<div style="margin-top:4px;display:flex;gap:4px;align-items:center;">'
      + '<span style="color:#555;white-space:nowrap;font-size:11px;">保存先ルート:</span>'
      + '<input id="kowaBulkRoot" type="text" placeholder="例: C:\\\\Users\\\\あなた\\\\Dropbox（各PCで1回設定）" style="flex:1;font:11px monospace;box-sizing:border-box;padding:2px 4px;">'
      + '</div>'
      + '<div id="kowaBulkStatus" style="margin-top:6px;min-height:16px;color:#555;word-break:break-all;"></div>'
      + '<div style="margin-top:4px;color:#999;font-size:11px;">※入力後は積算シートと合計金額が合うか確認。保存は「登録」ボタンで（「確定」「削除」は押さない）。<br>※「内容情報を入力」は内容フォームに担当者・アンペア数を入れるだけ。<b>登録ボタンは自分で確認して押す</b>こと。</div>'
      + '</div>';
    document.body.appendChild(wrap);

    var body = wrap.querySelector('#kowaBulkBody');
    wrap.querySelector('#kowaBulkMin').onclick = function () {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
      this.textContent = body.style.display === 'none' ? '＋' : '－';
    };
    wrap.querySelector('#kowaBulkRun').onclick = function () {
      run(document.getElementById('kowaBulkInput').value, document.getElementById('kowaBulkStatus'));
    };
    wrap.querySelector('#kowaBulkNaiyo').onclick = function () {
      fillNaiyo(document.getElementById('kowaBulkInput').value, document.getElementById('kowaBulkStatus'));
    };
    wrap.querySelector('#kowaBulkPath').onclick = function () {
      copySavePath(document.getElementById('kowaBulkInput').value, document.getElementById('kowaBulkStatus'));
    };
    var rootInput = wrap.querySelector('#kowaBulkRoot');
    rootInput.value = getRoot();
    rootInput.addEventListener('change', function () { setRoot(this.value.trim()); });
    rootInput.addEventListener('blur', function () { setRoot(this.value.trim()); });
    wrap.querySelector('#kowaBulkClear').onclick = function () {
      document.getElementById('kowaBulkInput').value = '';
      document.getElementById('kowaBulkStatus').textContent = '';
    };

    // ヘッダードラッグで移動
    (function () {
      var head = wrap.querySelector('#kowaBulkHead'), drag = false, ox = 0, oy = 0;
      head.addEventListener('mousedown', function (e) {
        if (e.target.id === 'kowaBulkMin') return;
        drag = true; ox = e.clientX - wrap.offsetLeft; oy = e.clientY - wrap.offsetTop; e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!drag) return; wrap.style.left = (e.clientX - ox) + 'px'; wrap.style.top = (e.clientY - oy) + 'px'; wrap.style.right = 'auto';
      });
      document.addEventListener('mouseup', function () { drag = false; });
    })();
  }

  // ===================================================================
  // 工事完了ページ（repair_comp_edit.asp）：完了日 一括入力（同一ISPの別ページ）
  //   修繕完了日＝実完了日／各商品の工事完了日＝発注書発行日。登録まで自動・確定は手動。
  //   見積ページ側のコードには一切触れない（URLで分岐）。@grant none なので window.confirm 直で効く。
  // ===================================================================
  var K_LS_LIST = 'isp_kanryo_list', K_LS_AUTO = 'isp_kanryo_auto';
  function kIsPage() { return /\/spodr\/repair_comp\/repair_comp_edit\.asp/i.test(location.pathname); }
  function kNorm(s) { return String(s || '').replace(/[\s　]/g, '').toLowerCase(); }
  function kNz(s) { return String(s || '').replace(/^0+/, ''); }
  function kYmd(s) {
    s = String(s || '').trim().replace(/-/g, '/');
    var m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (m) return m[1] + '/' + ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2);
    m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) return '2026/' + ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2);
    return s;
  }
  function kSet(el, v) { if (!el) return; el.value = v; ['change', 'blur'].forEach(function (ev) { el.dispatchEvent(new Event(ev, { bubbles: true })); }); }
  function kKill() { try { window.confirm = function () { return true; }; window.alert = function () { }; window.onbeforeunload = null; } catch (e) { } }
  function kRec() {
    var el = document.getElementsByName('div_title')[0];
    var t = (el && el.value) || document.title || '';
    var m = t.match(/（(.+?)[：:](.+?)）/);
    return m ? { bukken: m[1].trim(), room: m[2].trim() } : { bukken: '', room: '' };
  }
  function kParseList(text) {
    var DATE = '(\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}|\\d{1,2}\\/\\d{1,2})';
    return text.split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      l = l.replace(/^[・\-•\s　]+/, ''); // 行頭の「・」等を除去
      // クラ助形式:「物件名 号室 完了[予定] M/D／発注 M/D」
      var mk = l.match(new RegExp('完了(?:予定)?\\s*[:：]?\\s*' + DATE));
      var mh = l.match(new RegExp('発注\\s*[:：]?\\s*' + DATE));
      if (mk && mh) {
        var head = l.slice(0, l.indexOf(mk[0])).trim(); // 「完了」より前＝物件名+号室
        var tk = head.split(/[\s　]+/).filter(Boolean);
        var room = '', bukken = '';
        if (tk.length >= 2) { room = tk[tk.length - 1]; bukken = tk.slice(0, tk.length - 1).join(' '); }
        else { bukken = head; }
        return { bukken: bukken, room: room, kanryo: kYmd(mk[1]), hatchu: kYmd(mh[1]), yotei: /完了予定/.test(mk[0]) };
      }
      // 従来形式（ラベル無し）:「物件名 号室 完了日 発注日」
      var t2 = l.split(/[\s,　]+/).filter(Boolean);
      if (t2.length >= 3) {
        var room2 = '', bk2 = '';
        if (t2.length >= 4) { room2 = t2[t2.length - 3]; bk2 = t2.slice(0, t2.length - 3).join(' '); }
        else { bk2 = t2.slice(0, t2.length - 2).join(' '); }
        return { bukken: bk2, room: room2, kanryo: kYmd(t2[t2.length - 2]), hatchu: kYmd(t2[t2.length - 1]), yotei: false };
      }
      return null;
    }).filter(Boolean);
  }
  function kMatch(list, rec) {
    return list.find(function (x) {
      if (x.yotei) return false; // 完了予定はISP工事完了の対象外
      var bk = kNorm(x.bukken) && (kNorm(rec.bukken).indexOf(kNorm(x.bukken)) >= 0 || kNorm(x.bukken).indexOf(kNorm(rec.bukken)) >= 0);
      var rm = !x.room || kNz(rec.room) === kNz(x.room);
      return bk && rm;
    });
  }
  function kFill(kanryo, hatchu) {
    kKill();
    kSet(document.getElementsByName('txtSyuzenKoujiKanryoDate')[0], kYmd(kanryo));
    var items = document.querySelectorAll('input[name^="txtShnInfoKoujiKanryoDate_"]');
    items.forEach(function (el) { kSet(el, kYmd(hatchu)); });
    return items.length;
  }
  function kRegister() { kKill(); var img = document.getElementById('btn_02_img'); if (img) (img.closest('a') || img.parentElement).click(); }
  function kDone(kanryo) { var el = document.getElementsByName('txtSyuzenKoujiKanryoDate')[0]; return !!(el && el.value && el.value === kYmd(kanryo)); }

  function buildKanryoPanel() {
    if (document.getElementById('kowaKanryoPanel')) return;
    var rec = kRec(), list = kParseList(localStorage.getItem(K_LS_LIST) || ''), hit = kMatch(list, rec), auto = localStorage.getItem(K_LS_AUTO) === '1';
    var wrap = document.createElement('div');
    wrap.id = 'kowaKanryoPanel';
    wrap.style.cssText = 'position:fixed;top:90px;right:16px;z-index:99999;width:330px;font:12px/1.5 "Meiryo",sans-serif;background:#fff;border:2px solid #1565c0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    wrap.innerHTML =
      '<div style="background:#1565c0;color:#fff;padding:7px 10px;font-weight:bold;border-radius:5px 5px 0 0;">🔧 ISP完了日 一括入力</div>'
      + '<div style="padding:10px;">'
      + '<div id="kk_rec" style="font-size:11px;color:#555;margin-bottom:6px;"></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px;">'
      + '<label style="flex:1;">完了日<br><input id="kk_kanryo" style="width:100%;box-sizing:border-box;" placeholder="6/19 か 2026/06/19"></label>'
      + '<label style="flex:1;">発注日<br><input id="kk_hatchu" style="width:100%;box-sizing:border-box;" placeholder="6/2 か 2026/06/02"></label></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px;">'
      + '<button id="kk_fill" style="flex:1;background:#ddd;border:0;border-radius:4px;padding:7px;cursor:pointer;">入力のみ</button>'
      + '<button id="kk_reg" style="flex:1;background:#1565c0;color:#fff;border:0;border-radius:4px;padding:7px;font-weight:bold;cursor:pointer;">入力＋登録</button></div>'
      + '<label style="display:block;margin-bottom:6px;"><input type="checkbox" id="kk_auto"> 自動（開いたら入力＋登録）</label>'
      + '<details><summary style="cursor:pointer;color:#1565c0;">1日分のリストを貼る（物件 号室 完了日 発注日）</summary>'
      + '<textarea id="kk_list" rows="5" style="width:100%;box-sizing:border-box;font:11px monospace;" placeholder="フローセラス銀杏町 207 6/19 6/2&#10;クレージェ原町 202 6/18 6/10"></textarea>'
      + '<button id="kk_save" style="margin-top:4px;cursor:pointer;">リスト保存</button> <span id="kk_msg" style="font-size:11px;color:#080;"></span></details>'
      + '<div style="font-size:11px;color:#b71c1c;margin-top:6px;">※確定は内容を確認してから手動で押してください</div>'
      + '</div>';
    document.body.appendChild(wrap);
    var q = function (id) { return wrap.querySelector(id); };
    q('#kk_rec').textContent = rec.bukken ? ('現在: ' + rec.bukken + ' ' + rec.room + (hit ? '（リスト一致）' : '（未一致＝手入力）')) : '物件を判定できません';
    if (hit) { q('#kk_kanryo').value = hit.kanryo; q('#kk_hatchu').value = hit.hatchu; }
    q('#kk_list').value = localStorage.getItem(K_LS_LIST) || '';
    q('#kk_auto').checked = auto;
    q('#kk_fill').onclick = function () { kFill(q('#kk_kanryo').value, q('#kk_hatchu').value); };
    q('#kk_reg').onclick = function () { kFill(q('#kk_kanryo').value, q('#kk_hatchu').value); setTimeout(kRegister, 150); };
    q('#kk_auto').onchange = function (e) { localStorage.setItem(K_LS_AUTO, e.target.checked ? '1' : '0'); };
    q('#kk_save').onclick = function () { localStorage.setItem(K_LS_LIST, q('#kk_list').value); q('#kk_msg').textContent = '保存しました（次の物件から有効）'; };
    if (auto && hit && !kDone(hit.kanryo)) { kFill(hit.kanryo, hit.hatchu); setTimeout(kRegister, 300); }
  }

  // ===================================================================
  // V2: 一括バッチ（一覧⇄編集を自動で回す）。@matchに repair_list.asp 追加。
  //   検索/詳細のクリックハンドラは内側div（#divSearch / #detail_N）に付くので、そこをclickする。
  //   安全: 開いた物件がリストと不一致→停止／既に別の完了日→停止／確定は手動／ドライランあり。
  // ===================================================================
  var K_LS_BATCH = 'isp_batch';
  function kIsListPage() { return /\/spodr\/repair_comp\/repair_list\.asp/i.test(location.pathname); }
  function bGet() { try { return JSON.parse(localStorage.getItem(K_LS_BATCH) || 'null'); } catch (e) { return null; } }
  function bSet(o) { localStorage.setItem(K_LS_BATCH, JSON.stringify(o)); }
  function bStop(msg) { var b = bGet(); if (b) { b.running = false; bSet(b); } if (msg) alert('一括処理を停止：\n' + msg); }
  function bFinish(b) {
    b.running = false; bSet(b);
    var sk = (b.skipped || []);
    alert('一括処理 完了\n対象 ' + b.items.length + '件中 登録 ' + (b.items.length - sk.length) + '件' + (b.dry ? '（ドライラン＝実際は未登録）' : '（未確定）') + (sk.length ? '\nスキップ(一覧に無し) ' + sk.length + '件: ' + sk.join('、') : '') + '\n\n各レコードで確認して「確定」を押してください。');
  }
  function kClick(el) { if (!el) return false; if (window.jQuery) window.jQuery(el).trigger('click'); else el.click(); return true; }

  function maybeRunBatchList() {
    var b = bGet(); if (!b || !b.running) return;
    if (b.idx >= b.items.length) { bFinish(b); return; }
    var it = b.items[b.idx];
    if (b.phase === 'search') {
      var ni = document.getElementsByName('txtSearchTtyName')[0];
      if (ni) ni.value = it.bukken;
      ['txtSearchKoujiNo', 'txtSearchTtyKnrNo', 'txtSearchBasyoName'].forEach(function (n) { var e = document.getElementsByName(n)[0]; if (e) e.value = ''; });
      b.phase = 'open'; bSet(b);
      setTimeout(function () { kClick(document.getElementById('divSearch')); }, 500); // 検索ハンドラは内側#divSearch
      return;
    }
    if (b.phase === 'open') {
      var rows = [].slice.call(document.querySelectorAll('table tr')).filter(function (tr) { return tr.querySelectorAll('td').length >= 4 && tr.textContent.indexOf('建物名') < 0; });
      var target = null;
      rows.forEach(function (tr) {
        if (target) return;
        var tds = [].slice.call(tr.querySelectorAll('td')).map(function (td) { return td.textContent.trim(); });
        var hasB = tds.some(function (t) { return kNorm(t) && kNorm(t).indexOf(kNorm(it.bukken)) >= 0; });
        var hasR = !it.room || tds.some(function (t) { return /\d/.test(t) && kNz(t) === kNz(it.room); });
        if (hasB && hasR) target = tr;
      });
      if (!target) { // 一覧に無い→危険ではないのでスキップして次へ
        b.skipped = b.skipped || []; b.skipped.push(it.bukken + ' ' + (it.room || ''));
        b.idx++; b.phase = 'search'; bSet(b);
        if (b.idx >= b.items.length) { bFinish(b); } else { setTimeout(maybeRunBatchList, 400); }
        return;
      }
      var det = target.querySelector('div[id^="detail_"]') || target.querySelector('a'); // 詳細ハンドラは内側#detail_N
      setTimeout(function () { kClick(det); }, 400);
      return;
    }
  }

  function maybeRunBatchEdit() {
    var b = bGet(); if (!b || !b.running) return;
    if (b.idx >= b.items.length) { b.running = false; bSet(b); return; }
    var it = b.items[b.idx], rec = kRec();
    var bkOk = kNorm(rec.bukken) && (kNorm(rec.bukken).indexOf(kNorm(it.bukken)) >= 0 || kNorm(it.bukken).indexOf(kNorm(rec.bukken)) >= 0);
    var rmOk = !it.room || kNz(rec.room) === kNz(it.room);
    if (!bkOk || !rmOk) { bStop('開いた物件がリストと不一致。\n期待: ' + it.bukken + ' ' + it.room + '\n実際: ' + rec.bukken + ' ' + rec.room); return; }
    var el = document.getElementsByName('txtSyuzenKoujiKanryoDate')[0], cur = el ? el.value : '';
    var advance = function () {
      var bb = bGet(); bb.idx++;
      if (bb.idx >= bb.items.length) { bFinish(bb); }
      else { bb.phase = 'search'; bSet(bb); setTimeout(function () { location.href = 'repair_list.asp'; }, 600); }
    };
    if (cur === kYmd(it.kanryo)) { advance(); return; }   // 登録済み(or登録後の再読込)→次へ
    if (cur) { bStop('既に別の完了日（' + cur + '）が入っています。手動確認を: ' + rec.bukken + ' ' + rec.room); return; }
    kFill(it.kanryo, it.hatchu);                          // 空→入力
    if (b.dry) { setTimeout(advance, 1000); return; }     // ドライラン：登録せず次へ
    setTimeout(kRegister, 300);                           // 本番：登録→postback→再読込→cur==target→advance
    setTimeout(function () {                              // 登録失敗監視（再読込されればこのタイマーは消える）
      var e2 = document.getElementsByName('txtSyuzenKoujiKanryoDate')[0];
      if (e2 && e2.value !== kYmd(it.kanryo)) bStop('登録できていない可能性: ' + rec.bukken + ' ' + rec.room + '（手動確認を）');
    }, 5000);
  }

  function buildBatchPanel() {
    if (document.getElementById('kowaBatchPanel')) return;
    var b = bGet();
    var wrap = document.createElement('div');
    wrap.id = 'kowaBatchPanel';
    wrap.style.cssText = 'position:fixed;top:90px;right:16px;z-index:99999;width:330px;font:12px/1.5 "Meiryo",sans-serif;background:#fff;border:2px solid #6a1b9a;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    wrap.innerHTML =
      '<div style="background:#6a1b9a;color:#fff;padding:7px 10px;font-weight:bold;border-radius:5px 5px 0 0;">⚙️ ISP完了日 一括バッチ</div>'
      + '<div style="padding:10px;">'
      + '<div style="color:#555;margin-bottom:5px;font-size:11px;">リストを貼って開始すると、各物件を自動で開いて完了日を入力→登録まで回します（<b>確定は手動</b>）。まず<b>ドライラン</b>で動作確認を推奨。</div>'
      + '<textarea id="kb_list" rows="6" style="width:100%;box-sizing:border-box;font:11px monospace;" placeholder="物件名 号室 完了日 発注日（1行1物件）&#10;クレージェ原町 202 6/18 6/10"></textarea>'
      + '<div style="display:flex;gap:6px;margin-top:6px;">'
      + '<button id="kb_dry" style="flex:1;background:#0277bd;color:#fff;border:0;border-radius:4px;padding:7px;cursor:pointer;">ドライラン</button>'
      + '<button id="kb_run" style="flex:1;background:#6a1b9a;color:#fff;border:0;border-radius:4px;padding:7px;font-weight:bold;cursor:pointer;">本番開始</button>'
      + '<button id="kb_stop" style="background:#c62828;color:#fff;border:0;border-radius:4px;padding:7px 10px;cursor:pointer;">停止</button></div>'
      + '<div id="kb_status" style="margin-top:6px;font-size:11px;color:#333;min-height:16px;"></div>'
      + '<div style="font-size:11px;color:#b71c1c;margin-top:4px;">※ドライランは登録せず動作だけ。確定は最後に人が押す。途中で止めたい時は「停止」。</div>'
      + '</div>';
    document.body.appendChild(wrap);
    var q = function (id) { return wrap.querySelector(id); };
    q('#kb_list').value = localStorage.getItem(K_LS_LIST) || '';
    var stat = q('#kb_status');
    if (b && b.running && b.items[b.idx]) stat.textContent = '実行中… ' + (b.idx + 1) + '/' + b.items.length + '：' + b.items[b.idx].bukken + ' ' + b.items[b.idx].room + (b.dry ? '（ドライラン）' : '');
    var start = function (dry) {
      var all = kParseList(q('#kb_list').value);
      var items = all.filter(function (x) { return !x.yotei; }); // ISP工事完了は実完了のみ（完了予定は除外）
      var skipped = all.length - items.length;
      if (!items.length) { stat.style.color = '#c00'; stat.textContent = '登録対象（完了）がありません' + (skipped ? '（完了予定' + skipped + '件は対象外）' : '（形式: 物件名 号室 完了 M/D／発注 M/D）'); return; }
      localStorage.setItem(K_LS_LIST, q('#kb_list').value);
      bSet({ running: true, dry: !!dry, items: items, idx: 0, phase: 'search', skipped: [] });
      stat.style.color = '#333'; stat.textContent = (dry ? 'ドライラン' : '本番') + '開始：' + items.length + '件' + (skipped ? '（完了予定' + skipped + '件は除外）' : '') + '…';
      setTimeout(maybeRunBatchList, 300);
    };
    q('#kb_run').onclick = function () { if (window.confirm('本番実行します（各物件を自動で開いて入力→登録。確定は手動）。よろしいですか？')) start(false); };
    q('#kb_dry').onclick = function () { start(true); };
    q('#kb_stop').onclick = function () { var bb = bGet(); if (bb) { bb.running = false; bSet(bb); } stat.textContent = '停止しました'; };
  }

  // ---- 起動：ページで3分岐（見積=従来 / 工事完了編集=完了日パネル+バッチ実行 / 工事完了一覧=バッチパネル+実行）----
  function boot() {
    if (kIsListPage()) { buildBatchPanel(); maybeRunBatchList(); }
    else if (kIsPage()) { var b = bGet(); if (b && b.running) { maybeRunBatchEdit(); } else { buildKanryoPanel(); } }
    else { buildPanel(); }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 600);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 600); });
  }
})();
