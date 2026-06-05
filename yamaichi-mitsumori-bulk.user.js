// ==UserScript==
// @name         山一見積 一括入力（その他商品情報）
// @namespace    kowa-kogyo.tools
// @version      1.3.0
// @description  修繕業者WEB(ISP)の見積登録ページに「一括入力」パネルを追加。積算シートの表をそのまま貼り付けて、見積情報＋備考情報＋負担情報へ一括投入（売価単価=見積単価/備考=室名+仕様/依頼元単価=請求単価/家主・契約者の負担%は負担区分から自動）。重ね貼り時の余り行クリア＆商品名の全タブ同期に対応。
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
//     内容情報タブ（担当者名/アンペア数/特記事項）は今後の段階で追加予定。

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
      + '<div id="kowaBulkStatus" style="margin-top:6px;min-height:16px;color:#555;"></div>'
      + '<div style="margin-top:4px;color:#999;font-size:11px;">※入力後は積算シートと合計金額が合うか確認。保存は「登録」ボタンで（「確定」「削除」は押さない）。</div>'
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
