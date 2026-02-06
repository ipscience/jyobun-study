// 条文スタディ - 検索ページスクリプト
'use strict';

// HTMLエスケープ（XSS対策）
function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// 条文キャッシュ（上限100件、LRU方式）
const CACHE_MAX_SIZE = 100;
const articleCache = {};
const cacheOrder = [];  // LRU追跡用

function addToCache(key, value) {
    if (articleCache[key]) {
        // 既存キーを最新に移動し、値も更新
        const idx = cacheOrder.indexOf(key);
        if (idx > -1) cacheOrder.splice(idx, 1);
        cacheOrder.push(key);
        articleCache[key] = value;
        return;
    }
    // 上限超過時は最古を削除
    if (cacheOrder.length >= CACHE_MAX_SIZE) {
        const oldest = cacheOrder.shift();
        delete articleCache[oldest];
    }
    articleCache[key] = value;
    cacheOrder.push(key);
}

// 履歴
let history = [];
let currentIndex = -1;

// 法令名なしで入力された条番号を一時保存
let pendingArticleNum = null;

// DOM要素
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const backBtn = document.getElementById('back-btn');
const resultDiv = document.getElementById('result');

// URLからクエリパラメータを取得
const urlParams = new URLSearchParams(window.location.search);
const initialQuery = urlParams.get('q') || '';

// 初期クエリがあれば検索ボックスにセット
if (initialQuery) {
    searchInput.value = initialQuery;
}

// 検索ボタンクリック
searchBtn.addEventListener('click', () => doSearch());

// Enterキーで検索
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
});

// クイックリンク
document.querySelectorAll('.quick-link').forEach(btn => {
    btn.addEventListener('click', () => {
        const law = btn.dataset.law;
        // 保留中の条番号があればそれを使用
        if (pendingArticleNum) {
            searchInput.value = law + pendingArticleNum;
            pendingArticleNum = null;
        } else {
            searchInput.value = law + '第1条';
        }
        doSearch();
    });
});

// 戻るボタン
backBtn.addEventListener('click', () => {
    if (currentIndex > 0) {
        currentIndex--;
        const prev = history[currentIndex];
        displayArticle(prev.lawName, prev.articleNum, prev.fullRef, false);
    }
});

// 検索実行
function doSearch() {
    const text = searchInput.value.trim();
    if (!text) return;
    
    const parsed = parseLawReference(text);
    if (parsed) {
        pendingArticleNum = null; // 成功したらクリア
        displayArticle(parsed.lawName, parsed.articleNum, parsed.fullRef, true);
    } else {
        // 法令名なしの条番号かチェック
        const articleOnly = parseArticleOnly(text);
        if (articleOnly) {
            pendingArticleNum = articleOnly;
            showSelectLaw(articleOnly);
        } else {
            showNoMatch(text);
        }
    }
}

// 条番号のみをパース（法令名なし）
function parseArticleOnly(text) {
    const normalizedText = text.replace(/\s+/g, '').replace(/条の([一二三四五六七八九十0-9０-９]+)条/g, '条の$1');
    const pattern = /^第?([一二三四五六七八九十百千0-9０-９]+)条(?:の([一二三四五六七八九十0-9０-９]+))?(?:第?([一二三四五六七八九十0-9０-９]+)項)?(?:第?([一二三四五六七八九十0-9０-９]+)号)?$/;
    const match = normalizedText.match(pattern);
    if (match) {
        return normalizedText; // 正規化された条番号文字列を返す
    }
    return null;
}

// 法令選択を促すメッセージを表示
function showSelectLaw(articleNum) {
    resultDiv.innerHTML = `
        <div class="select-law-prompt">
            <div class="prompt-icon">📋</div>
            <h3>法令を選択してください</h3>
            <p>「<strong>${articleNum}</strong>」を検索するには、下のボタンから法令を選んでください。</p>
            <div class="law-select-buttons">
                <button class="law-select-btn" data-law="特許法">特許法</button>
                <button class="law-select-btn" data-law="実用新案法">実用新案法</button>
                <button class="law-select-btn" data-law="意匠法">意匠法</button>
                <button class="law-select-btn" data-law="商標法">商標法</button>
                <button class="law-select-btn" data-law="著作権法">著作権法</button>
                <button class="law-select-btn" data-law="不正競争防止法">不競法</button>
                <button class="law-select-btn" data-law="憲法">憲法</button>
                <button class="law-select-btn" data-law="民法">民法</button>
                <button class="law-select-btn" data-law="商法">商法</button>
                <button class="law-select-btn" data-law="民事訴訟法">民訴法</button>
                <button class="law-select-btn" data-law="刑事訴訟法">刑訴法</button>
            </div>
        </div>
    `;
    
    // ボタンにイベント追加
    resultDiv.querySelectorAll('.law-select-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const lawName = btn.dataset.law;
            searchInput.value = lawName + pendingArticleNum;
            pendingArticleNum = null;
            doSearch();
        });
    });
}

// 法令参照をパース
function parseLawReference(text) {
    // PDFからのコピー時に入る空白を除去
    const normalizedText = text.replace(/\s+/g, '').replace(/条の([一二三四五六七八九十0-9０-９]+)条/g, '条の$1');
    
    const LAW_NAMES = Object.keys(LAW_IDS).join('|');
    const LAW_ABBREVS = Object.keys(LAW_ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|');
    const pattern = new RegExp(
        `(${LAW_NAMES}|${LAW_ABBREVS})(第?[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?(?:第?[一二三四五六七八九十0-9０-９]+項)?(?:第?[一二三四五六七八九十0-9０-９]+号)?)`
    );
    
    const match = normalizedText.match(pattern);
    if (match) {
        let lawName = match[1];
        const articleNum = match[2];
        
        // 略称を正式名称に変換
        if (LAW_ABBREVIATIONS[lawName]) {
            lawName = LAW_ABBREVIATIONS[lawName];
        }
        
        return { lawName, articleNum, fullRef: match[0] };
    }
    return null;
}

// 漢数字をアラビア数字に変換
function kanjiToNumber(str) {
    const kanjiNums = {
        '〇': '0', '一': '1', '二': '2', '三': '3', '四': '4',
        '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
        '十': '10', '百': '100', '千': '1000',
        '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
        '５': '5', '６': '6', '７': '7', '８': '8', '９': '9'
    };
    
    // 全角数字を半角に
    let result = str.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
    
    // 漢数字を処理
    if (/[一二三四五六七八九十百千]/.test(result)) {
        let num = 0;
        let temp = 0;
        for (let char of result) {
            if (kanjiNums[char]) {
                const val = parseInt(kanjiNums[char]);
                if (val >= 10) {
                    if (temp === 0) temp = 1;
                    if (val === 1000) {
                        num += temp * 1000;
                        temp = 0;
                    } else if (val === 100) {
                        num += temp * 100;
                        temp = 0;
                    } else if (val === 10) {
                        num += temp * 10;
                        temp = 0;
                    }
                } else {
                    temp = temp * 10 + val;
                }
            }
        }
        num += temp;
        return num.toString();
    }
    
    return result.replace(/\D/g, '');
}

// 条番号から条文XMLのarticle_numパラメータ形式に変換
function parseArticleNumber(articleNum) {
    // 「第」を除去
    let num = articleNum.replace(/第/g, '');
    
    // 「条の」パターンを処理（例：「2条の3」→「2_3」）
    const match = num.match(/([一二三四五六七八九十百千0-9０-９]+)条の([一二三四五六七八九十0-9０-９]+)/);
    if (match) {
        const main = kanjiToNumber(match[1]);
        const sub = kanjiToNumber(match[2]);
        return `${main}_${sub}`;
    }
    
    // 通常の条番号
    const simpleMatch = num.match(/([一二三四五六七八九十百千0-9０-９]+)条/);
    if (simpleMatch) {
        return kanjiToNumber(simpleMatch[1]);
    }
    
    return kanjiToNumber(num);
}

// 条文を取得
async function fetchArticle(lawName, articleNum) {
    const lawId = LAW_IDS[lawName];
    if (!lawId) {
        throw new Error(`法令「${lawName}」は対応していません`);
    }
    
    const articleNumForApi = parseArticleNumber(articleNum);
    const cacheKey = `${lawId}_${articleNumForApi}`;
    
    if (articleCache[cacheKey]) {
        return articleCache[cacheKey];
    }
    
    const apiUrl = `https://laws.e-gov.go.jp/api/1/articles;lawId=${lawId};article=${articleNumForApi}`;
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`条文が見つかりませんでした (${response.status})`);
    }
    
    const xmlText = await response.text();
    
    // APIエラーをチェック
    if (xmlText.includes('<Code>1</Code>')) {
        throw new Error('条文が見つかりませんでした');
    }
    
    const result = parseArticleXml(xmlText, lawName);
    addToCache(cacheKey, result);
    return result;
}

// XMLをパース
function parseArticleXml(xmlText, lawName) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    
    const articles = xmlDoc.querySelectorAll('Article');
    if (articles.length === 0) {
        return { title: '', content: '条文が見つかりませんでした' };
    }
    
    let html = '';
    
    articles.forEach(article => {
        const articleCaption = article.querySelector('ArticleCaption');
        const articleTitle = article.querySelector('ArticleTitle');
        
        if (articleCaption) {
            html += `<div class="article-caption">（${escapeHtml(articleCaption.textContent)}）</div>`;
        }
        
        if (articleTitle) {
            html += `<div class="article-title-text">${escapeHtml(articleTitle.textContent)}</div>`;
        }
        
        const paragraphs = article.querySelectorAll(':scope > Paragraph');
        paragraphs.forEach(para => {
            const paraNum = para.querySelector('ParagraphNum');
            const paraSentence = para.querySelector('ParagraphSentence');
            
            let paraHtml = '<p>';
            if (paraNum && paraNum.textContent) {
                paraHtml += `<strong>${escapeHtml(paraNum.textContent)}</strong>　`;
            }
            if (paraSentence) {
                paraHtml += processXmlContent(paraSentence, lawName);
            }
            paraHtml += '</p>';
            html += paraHtml;
            
            // 号を処理
            const items = para.querySelectorAll(':scope > Item');
            if (items.length > 0) {
                html += '<div class="items">';
                items.forEach(item => {
                    const itemTitle = item.querySelector('ItemTitle');
                    const itemSentence = item.querySelector('ItemSentence');
                    
                    let itemHtml = '<div class="item">';
                    if (itemTitle) {
                        itemHtml += `<span class="item-title">${escapeHtml(itemTitle.textContent)}</span>　`;
                    }
                    if (itemSentence) {
                        itemHtml += processXmlContent(itemSentence, lawName);
                    }
                    itemHtml += '</div>';
                    html += itemHtml;
                });
                html += '</div>';
            }
        });
    });
    
    const articleTitle = articles[0].querySelector('ArticleTitle');
    const title = articleTitle ? articleTitle.textContent : '';
    
    return { title, content: html };
}

// XML内容を処理（リンク変換含む）
function processXmlContent(element, lawName) {
    let html = '';
    
    element.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            html += highlightParentheses(node.textContent);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'a' || node.tagName === 'A') {
                // e-Govのアンカーリンクを内部リンクに変換
                const href = node.getAttribute('href');
                const text = node.textContent;
                
                if (href && href.startsWith('#')) {
                    // 内部リンク
                    const linkData = parseAnchorHref(href, lawName);
                    if (linkData) {
                        html += `<span class="internal-link" data-law="${linkData.lawName}" data-article="${linkData.articleNum}" data-ref="${text}">${text}</span>`;
                    } else {
                        html += text;
                    }
                } else {
                    html += text;
                }
            } else {
                html += processXmlContent(node, lawName);
            }
        }
    });
    
    return html;
}

// アンカーリンクをパース
function parseAnchorHref(href, currentLawName) {
    // 例: #1000000000000000000000000000000000000000000029000000000000000000000000000
    // または #Mp-At_36-Pr_1
    
    const articleMatch = href.match(/At[_-](\d+)/);
    if (articleMatch) {
        return {
            lawName: currentLawName,
            articleNum: `第${articleMatch[1]}条`
        };
    }
    
    return null;
}

// 括弧内をハイライト
function highlightParentheses(text) {
    // タイトル括弧や番号のみの括弧は除外
    return text.replace(/（([^）]+)）/g, (match, content, offset) => {
        // 先頭の括弧（タイトル）は除外
        if (offset === 0) {
            return match;
        }
        // 番号のみの括弧は除外
        if (/^[０-９0-9ａ-ｚa-zＡ-Ｚ一二三四五六七八九十]+$/.test(content)) {
            return match;
        }
        return `<span class="parentheses-content">（${content}）</span>`;
    });
}

// 条文を表示
async function displayArticle(lawName, articleNum, fullRef, addToHistory = true) {
    const resultDiv = document.getElementById('result');
    resultDiv.innerHTML = '<div class="loading">条文を読み込み中</div>';
    
    if (addToHistory) {
        // 現在位置より後の履歴を削除
        history = history.slice(0, currentIndex + 1);
        history.push({ lawName, articleNum, fullRef });
        currentIndex = history.length - 1;
    }
    
    updateBackButton();
    
    try {
        const result = await fetchArticle(lawName, articleNum);
        
        resultDiv.innerHTML = `
            <div class="article-title">${escapeHtml(lawName)} ${escapeHtml(result.title || articleNum)}</div>
            <div class="study-controls">
                <button class="cloze-toggle" type="button">穴埋め</button>
            </div>
            <div class="article-content">${result.content}</div>
        `;

        const articleContent = resultDiv.querySelector('.article-content');
        const clozeBtn = resultDiv.querySelector('.cloze-toggle');
        if (articleContent && clozeBtn) {
            clozeBtn.addEventListener('click', () => {
                if (articleContent.querySelectorAll('.cloze').length === 0) {
                    applyCloze(articleContent, true);
                    clozeBtn.textContent = '答え表示';
                    return;
                }

                const hasHidden = articleContent.querySelector('.cloze-hidden') !== null;
                setClozeHidden(articleContent, !hasHidden);
                clozeBtn.textContent = hasHidden ? '穴埋め' : '答え表示';
            });
        }
        
        // 内部リンクのイベント設定
        resultDiv.querySelectorAll('.internal-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetLaw = link.dataset.law;
                const targetArticle = link.dataset.article;
                const ref = link.dataset.ref;
                displayArticle(targetLaw, targetArticle, ref, true);
            });
        });
        
    } catch (error) {
        resultDiv.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
}

// 戻るボタンの状態更新
function updateBackButton() {
    backBtn.disabled = currentIndex <= 0;
}

// 法令参照が見つからない場合のメッセージ
function showNoMatch(searchText) {
    resultDiv.innerHTML = `
        <div class="no-match">
            <h3>法令参照が見つかりませんでした</h3>
            <p>「${escapeHtml(searchText)}」から法令参照を検出できませんでした。</p>
            <p>以下の形式で入力してください：</p>
            <ul>
                <li>「特許法第29条」</li>
                <li>「民法第709条」</li>
                <li>「著作権法2条1項」</li>
                <li>「特29条」（略称も可）</li>
            </ul>
            <h4>対応法令</h4>
            <ul>
                ${Object.keys(LAW_IDS).map(name => `<li>${name}</li>`).join('')}
            </ul>
        </div>
    `;
}

// 初期化 - クエリがあれば自動検索
if (initialQuery) {
    doSearch();
}
