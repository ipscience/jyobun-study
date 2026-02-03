// 条文スタディ - ポップアップスクリプト
'use strict';

// law-data.js で定義された LAW_IDS, LAW_ABBREVIATIONS を使用

// キャッシュと履歴
const articleCache = {};
let history = [];
let currentIndex = -1;

// DOM要素
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const contentDiv = document.getElementById('content');
const floatingBtnToggle = document.getElementById('floating-btn-toggle');

// フローティングボタン表示設定の読み込みと更新
chrome.storage.sync.get({ showFloatingBtn: true }, (settings) => {
    floatingBtnToggle.checked = settings.showFloatingBtn;
});

floatingBtnToggle.addEventListener('change', () => {
    const showFloatingBtn = floatingBtnToggle.checked;
    chrome.storage.sync.set({ showFloatingBtn });
    
    // 全タブに即時反映
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { 
                    action: 'toggleFloatingBtn', 
                    visible: showFloatingBtn 
                }).catch(() => {}); // エラーは無視（chrome://ページなど）
            }
        });
    });
});

// イベントリスナー
searchBtn.addEventListener('click', () => search(searchInput.value));
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') search(searchInput.value);
});

// クイックリンク
document.querySelectorAll('.quick-link').forEach(btn => {
    btn.addEventListener('click', () => {
        const law = btn.dataset.law;
        searchInput.value = law + '第1条';
        search(searchInput.value);
    });
});

// 検索実行
function search(text) {
    if (!text.trim()) return;
    
    // 空白を除去して正規化
    const normalizedText = text.replace(/\s+/g, '');
    const parsed = parseLawReference(normalizedText);
    
    if (parsed) {
        displayArticle(parsed.lawName, parsed.articleNum, true);
    } else {
        showError('法令参照を認識できませんでした。「特許法29条」のような形式で入力してください。');
    }
}

// 法令参照をパース
function parseLawReference(text) {
    const LAW_NAMES = Object.keys(LAW_IDS).join('|');
    const LAW_ABBREVS = Object.keys(LAW_ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|');
    const pattern = new RegExp(
        `(${LAW_NAMES}|${LAW_ABBREVS})(第?[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?(?:第?[一二三四五六七八九十0-9０-９]+項)?(?:第?[一二三四五六七八九十0-9０-９]+号)?)`
    );
    
    const match = text.match(pattern);
    if (match) {
        let lawName = match[1];
        const articleNum = match[2];
        
        if (LAW_ABBREVIATIONS[lawName]) {
            lawName = LAW_ABBREVIATIONS[lawName];
        }
        
        return { lawName, articleNum };
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
    
    let result = str.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
    
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

// 条番号をAPI用に変換
function parseArticleNumber(articleNum) {
    let num = articleNum.replace(/第/g, '');
    
    const match = num.match(/([一二三四五六七八九十百千0-9０-９]+)条の([一二三四五六七八九十0-9０-９]+)/);
    if (match) {
        const main = kanjiToNumber(match[1]);
        const sub = kanjiToNumber(match[2]);
        return `${main}_${sub}`;
    }
    
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
    
    if (xmlText.includes('<Code>1</Code>')) {
        throw new Error('条文が見つかりませんでした');
    }
    
    const result = parseArticleXml(xmlText, lawName);
    articleCache[cacheKey] = result;
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
            html += `<div style="color:#666;font-size:12px;margin-bottom:4px;">（${articleCaption.textContent}）</div>`;
        }
        
        if (articleTitle) {
            html += `<div style="font-weight:bold;margin-bottom:8px;">${articleTitle.textContent}</div>`;
        }
        
        const paragraphs = article.querySelectorAll(':scope > Paragraph');
        paragraphs.forEach(para => {
            const paraNum = para.querySelector('ParagraphNum');
            const paraSentence = para.querySelector('ParagraphSentence');
            
            let paraHtml = '<p>';
            if (paraNum && paraNum.textContent) {
                paraHtml += `<strong>${paraNum.textContent}</strong>　`;
            }
            if (paraSentence) {
                paraHtml += processXmlContent(paraSentence, lawName);
            }
            paraHtml += '</p>';
            html += paraHtml;
            
            const items = para.querySelectorAll(':scope > Item');
            if (items.length > 0) {
                html += '<div class="items">';
                items.forEach(item => {
                    const itemTitle = item.querySelector('ItemTitle');
                    const itemSentence = item.querySelector('ItemSentence');
                    
                    let itemHtml = '<div class="item">';
                    if (itemTitle) {
                        itemHtml += `<span class="item-title">${itemTitle.textContent}</span>　`;
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

// XML内容を処理
function processXmlContent(element, lawName) {
    let html = '';
    
    element.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            html += highlightParentheses(node.textContent);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'a' || node.tagName === 'A') {
                const href = node.getAttribute('href');
                const text = node.textContent;
                
                if (href && href.startsWith('#')) {
                    const linkData = parseAnchorHref(href, lawName);
                    if (linkData) {
                        html += `<span class="internal-link" data-law="${linkData.lawName}" data-article="${linkData.articleNum}">${text}</span>`;
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
    return text.replace(/（([^）]+)）/g, (match, content, offset) => {
        if (offset === 0) return match;
        if (/^[０-９0-9ａ-ｚa-zＡ-Ｚ一二三四五六七八九十]+$/.test(content)) return match;
        return `<span class="parentheses-content">（${content}）</span>`;
    });
}

// 条文を表示
async function displayArticle(lawName, articleNum, addToHistory = true) {
    showLoading();
    
    if (addToHistory) {
        history = history.slice(0, currentIndex + 1);
        history.push({ lawName, articleNum });
        currentIndex = history.length - 1;
    }
    
    try {
        const result = await fetchArticle(lawName, articleNum);
        
        let navHtml = '';
        if (history.length > 1) {
            navHtml = `
                <div class="nav-bar">
                    <button class="nav-btn" id="back-btn" ${currentIndex <= 0 ? 'disabled' : ''}>◀ 戻る</button>
                </div>
            `;
        }
        
        contentDiv.innerHTML = `
            ${navHtml}
            <div class="article-title">${lawName} ${result.title || articleNum}</div>
            <div class="article-content">${result.content}</div>
            <button class="open-tab-btn" id="open-tab-btn">📄 新しいタブで開く</button>
        `;
        
        // 戻るボタン
        const backBtn = document.getElementById('back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (currentIndex > 0) {
                    currentIndex--;
                    const prev = history[currentIndex];
                    displayArticle(prev.lawName, prev.articleNum, false);
                }
            });
        }
        
        // 新しいタブで開く
        document.getElementById('open-tab-btn').addEventListener('click', () => {
            chrome.tabs.create({
                url: chrome.runtime.getURL(`search.html?q=${encodeURIComponent(lawName + articleNum)}`)
            });
        });
        
        // 内部リンク
        contentDiv.querySelectorAll('.internal-link').forEach(link => {
            link.addEventListener('click', () => {
                const targetLaw = link.dataset.law;
                const targetArticle = link.dataset.article;
                searchInput.value = targetLaw + targetArticle;
                displayArticle(targetLaw, targetArticle, true);
            });
        });
        
    } catch (error) {
        showError(error.message);
    }
}

// ローディング表示
function showLoading() {
    contentDiv.innerHTML = '<div class="loading">読み込み中</div>';
}

// エラー表示
function showError(message) {
    contentDiv.innerHTML = `<div class="error">${message}</div>`;
}
