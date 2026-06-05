// ==UserScript==
// @name         山一見積 一括入力（その他商品情報）
// @namespace    kowa-kogyo.tools
// @version      1.5.1
// @description  修繕業者WEB(ISP)の見積登録ページに「一括入力」パネルを追加。積算シートの表をそのまま貼り付けて、見積情報＋備考情報＋負担情報へ一括投入（売価単価=見積単価/備考=室名+仕様/依頼元単価=請求単価/家主・契約者の負担%は負担区分から自動）。先頭の担当者ブロックから内容情報フォームへ担当社員・アンペア数も入力（登録は手動）。保存先フォルダのコピー（その他情報の添付用）。重ね貼り時の余り行クリア＆商品名の全タブ同期に対応。
// @match        https://syuzen-yamaichi-j.i-vrdc.com/spodr/order/mitsumori_edit.asp*
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

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(buildPanel, 600);
  } else {
    window.addEventListener('load', function () { setTimeout(buildPanel, 600); });
  }
})();
