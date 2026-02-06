// 条文スタディ Chrome拡張機能
(function() {
    'use strict';

    // 既に初期化済みの場合はスキップ
    if (window.lawPopupInitialized) return;
    window.lawPopupInitialized = true;

    // 法令参照パターン（「第」は省略可能、スペースも許可）
    // 正式名称と略称の両方に対応
    const LAW_NAMES = Object.keys(LAW_IDS).join('|');
    const LAW_ABBREVS = Object.keys(LAW_ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|');
    const LAW_PATTERN = new RegExp(
        `(${LAW_NAMES}|${LAW_ABBREVS})\\s*(第?\\s*[一二三四五六七八九十百千0-9０-９]+\\s*条(?:\\s*の\\s*[一二三四五六七八九十0-9０-９]+)?(?:\\s*第?\\s*[一二三四五六七八九十0-9０-９]+\\s*項)?(?:\\s*第?\\s*[一二三四五六七八九十0-9０-９]+\\s*号)?)`,
        'g'
    );

    // 条文キャッシュ（上限100件、LRU方式）
    const CACHE_MAX_SIZE = 100;
    const articleCache = {};
    const cacheOrder = [];  // LRU追跡用

    function addToCache(key, value) {
        if (articleCache[key]) {
            // 既存キーを最新に移動
            const idx = cacheOrder.indexOf(key);
            if (idx > -1) cacheOrder.splice(idx, 1);
            cacheOrder.push(key);
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

    // ポップアップ要素を作成
    let popup = null;
    let currentHighlight = null;  // 現在ホバー中の法令参照要素

    // 条文表示履歴（戻るボタン用）
    let articleHistory = [];
    let currentArticleInfo = null;  // {lawName, articleNum}

    function createPopup() {
        if (popup) return popup;
        
        popup = document.createElement('div');
        popup.id = 'law-popup-container';
        popup.innerHTML = `
            <div class="popup-header">
                <button class="popup-back" title="前の条文に戻る" style="display: none;">◀ 戻る</button>
                <div class="popup-title"></div>
                <button class="popup-close">×</button>
            </div>
            <div class="popup-study-controls">
                <button class="popup-cloze" title="穴埋め">穴埋め</button>
            </div>
            <div class="popup-content"></div>
            <div class="popup-footer">
                © 2026 Hajime Kumami｜出典：<a href="https://laws.e-gov.go.jp/" target="_blank" rel="noopener noreferrer">e-Gov法令検索</a>
            </div>
        `;
        document.body.appendChild(popup);
        
        // 戻るボタン
        popup.querySelector('.popup-back').addEventListener('click', () => {
            if (articleHistory.length > 0) {
                const prev = articleHistory.pop();
                navigateToArticle(prev.lawName, prev.articleNum, prev.fullRef, false);
            }
        });
        
        // 閉じるボタン
        popup.querySelector('.popup-close').addEventListener('click', () => {
            popup.classList.remove('active');
            currentHighlight = null;
            articleHistory = [];
            currentArticleInfo = null;
        });

        // 穴埋めボタン
        popup.querySelector('.popup-cloze').addEventListener('click', () => {
            const content = popup.querySelector('.popup-content');
            const clozeBtn = popup.querySelector('.popup-cloze');
            if (!content) return;

            if (content.querySelectorAll('.cloze').length === 0) {
                applyCloze(content, true);
                clozeBtn.textContent = '答え表示';
                return;
            }

            const hasHidden = content.querySelector('.cloze-hidden') !== null;
            setClozeHidden(content, !hasHidden);
            clozeBtn.textContent = hasHidden ? '穴埋め' : '答え表示';
        });


        // ポップアップ外クリックで閉じる
        document.addEventListener('mousedown', (e) => {
            if (!popup.classList.contains('active')) return;
            if (popup.contains(e.target)) return;
            if (e.target.closest('.law-ref-highlight')) return;
            popup.classList.remove('active');
            currentHighlight = null;
            articleHistory = [];
            currentArticleInfo = null;
        });

        // Escキーで閉じる
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!popup.classList.contains('active')) return;
            popup.classList.remove('active');
            currentHighlight = null;
            articleHistory = [];
            currentArticleInfo = null;
        });
        
        // ポップアップ内のリンククリック（イベント委譲）
        popup.addEventListener('click', (e) => {
            const link = e.target.closest('.law-ref-internal');
            if (link) {
                e.preventDefault();
                e.stopPropagation();
                const lawName = link.dataset.law;
                const articleNum = link.dataset.article;
                const fullRef = link.dataset.fullRef || articleNum;
                if (lawName && articleNum) {
                    navigateToArticle(lawName, articleNum, fullRef, true);
                }
            }
        });

        return popup;
    }
    
    // 条文間ナビゲーション
    async function navigateToArticle(lawName, articleNum, fullRef, addToHistory) {
        const popup = createPopup();
        const title = popup.querySelector('.popup-title');
        const content = popup.querySelector('.popup-content');
        const backBtn = popup.querySelector('.popup-back');
        
        // 完全な参照（項・号含む）を使用、なければarticleNumを使用
        const displayRef = fullRef || articleNum;
        
        // 履歴に追加
        if (addToHistory && currentArticleInfo) {
            articleHistory.push(currentArticleInfo);
        }
        
        // 現在の条文情報を更新（fullRefも保持）
        currentArticleInfo = { lawName, articleNum, fullRef: displayRef };
        
        // 戻るボタンの表示/非表示
        backBtn.style.display = articleHistory.length > 0 ? 'block' : 'none';
        
        // 略称を正式名称に変換してタイトル表示
        const fullLawName = LAW_ABBREVIATIONS[lawName] || lawName;
        title.textContent = `${fullLawName}${articleNum}`;
        content.innerHTML = '<div class="popup-loading"><div class="spinner"></div><br>条文を取得中...</div>';

        // 条文を取得（fullRefを使ってハイライト）
        try {
            const articleText = await fetchArticle(lawName, displayRef);
            const safeHtml = sanitizeArticleHtml(articleText);
            // 他法令への外部リンクを処理
            const externalLinkedHtml = processPopupContentOffline(safeHtml);
            // 同一法令内の関連条文リンクを処理
            const processedHtml = processRelatedArticles(externalLinkedHtml, lawName, articleNum, displayRef);
            content.innerHTML = processedHtml;
            // 穴埋め状態をリセット
            content.dataset.clozeReady = 'false';
            const clozeBtn = popup.querySelector('.popup-cloze');
            if (clozeBtn) clozeBtn.textContent = '穴埋め';
        } catch (error) {
            content.innerHTML = `<div class="popup-error">条文の取得に失敗しました: ${error.message}</div>`;
        }
    }
    
    // 関連条文のリンク化（「第○条」「前項」「次条」など）
    function processRelatedArticles(htmlString, currentLawName, currentArticleNum, currentFullRef) {
        const fullLawName = LAW_ABBREVIATIONS[currentLawName] || currentLawName;
        // 対応法令のみ関連リンクを生成
        if (!LAW_IDS[fullLawName]) {
            return htmlString;
        }
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        
        // 現在の条番号を解析
        const currentMatch = currentArticleNum.match(/第?([一二三四五六七八九十百千0-9０-９]+)条(?:の([一二三四五六七八九十0-9０-９]+))?/);
        const currentMainNum = currentMatch ? convertToNumber(currentMatch[1]) : null;
        const currentSubNum = currentMatch && currentMatch[2] ? convertToNumber(currentMatch[2]) : null;
        const currentParagraphMatch = currentFullRef ? currentFullRef.match(/第([一二三四五六七八九十0-9０-９]+)項/) : null;
        const currentParagraphNum = currentParagraphMatch ? convertToNumber(currentParagraphMatch[1]) : null;
        
        // e-Govのアンカーリンクを内部リンクに変換
        convertEGovAnchorsToInternalLinks(tempDiv, currentLawName);
        
        // 括弧内のテキストを薄い灰色背景でハイライト
        let resultHtml = tempDiv.innerHTML;
        resultHtml = highlightParenthesesContent(resultHtml);
        
        return resultHtml;
    }

    // e-Govのアンカーリンクを内部リンクに変換
    function convertEGovAnchorsToInternalLinks(container, currentLawName) {
        const fullLawName = LAW_ABBREVIATIONS[currentLawName] || currentLawName;
        const currentLawId = LAW_IDS[fullLawName];
        if (!currentLawId) return;

        const anchors = container.querySelectorAll('a[href]');
        anchors.forEach(anchor => {
            const href = anchor.getAttribute('href');
            if (!href) return;
            try {
                const url = new URL(href, window.location.origin);
                if (url.protocol !== 'https:' || url.hostname !== 'laws.e-gov.go.jp') return;

                const lawIdMatch = url.pathname.match(/\/law\/([0-9A-Z]+)$/i);
                if (!lawIdMatch) return;
                const lawId = lawIdMatch[1];
                if (lawId !== currentLawId) return;

                const hash = url.hash || '';
                const anchorMatch = hash.match(/#MP-At_(\d+)(?:_(\d+))?/);
                if (!anchorMatch) return;

                const mainNum = parseInt(anchorMatch[1], 10);
                const subNum = anchorMatch[2] ? parseInt(anchorMatch[2], 10) : null;
                const articleRef = `第${numToKanji(mainNum)}条${subNum ? 'の' + numToKanji(subNum) : ''}`;

                const span = document.createElement('span');
                span.className = 'law-ref-internal';
                span.dataset.law = currentLawName;
                span.dataset.article = articleRef;

                const text = anchor.textContent || '';
                span.textContent = text || articleRef;
                span.dataset.fullRef = text && /第.+条/.test(text) ? text : articleRef;

                anchor.replaceWith(span);
            } catch (e) {
                // ignore invalid URL
            }
        });
    }
    
    // 括弧内のテキストを<span>で囲んでハイライト
    function highlightParenthesesContent(html) {
        // HTMLタグを一時的にプレースホルダーに置換
        const tags = [];
        let taggedHtml = html.replace(/<[^>]+>/g, (match) => {
            tags.push(match);
            return `\u0000TAG${tags.length - 1}\u0000`;
        });
        
        // 括弧内のテキストを処理（ネストに対応するため再帰的に処理）
        let maxIterations = 10;
        let iteration = 0;
        while (iteration < maxIterations) {
            let foundMatch = false;
            // 内側の括弧が処理された後もマッチするように \u0001 を許可
            const newHtml = taggedHtml.replace(/（([^（）]*?)）/g, (match, content, offset) => {
                // 括弧の直前の文字を確認（タグプレースホルダーと空白を除く）
                const beforeParen = taggedHtml.slice(0, offset);
                const cleanBefore = beforeParen.replace(/\u0000TAG\d+\u0000/g, '').replace(/\u0001[^\u0001]*\u0001/g, '').replace(/[\s　\n\r]+$/, '');
                
                // 直前に文字がなければ見出し（灰色にしない）
                if (cleanBefore.length === 0) {
                    return match;
                }
                
                // 括弧内が数字や英文字のみの場合は除外（例：（１）（ａ）（ｉｉ）など）
                const cleanContent = content.replace(/\u0000TAG\d+\u0000/g, '').replace(/\u0001[^\u0001]*\u0001/g, '');
                if (/^[0-9０-９a-zA-Zａ-ｚＡ-Ｚⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+$/.test(cleanContent)) {
                    return match;
                }
                
                foundMatch = true;
                return `\u0001PAREN_START\u0001${content}\u0001PAREN_END\u0001`;
            });
            if (!foundMatch || newHtml === taggedHtml) break;
            taggedHtml = newHtml;
            iteration++;
        }
        
        // プレースホルダーをHTMLに戻す
        taggedHtml = taggedHtml.replace(/\u0000TAG(\d+)\u0000/g, (match, index) => {
            return tags[parseInt(index)];
        });
        
        // 括弧のプレースホルダーをspanに変換
        taggedHtml = taggedHtml.replace(/\u0001PAREN_START\u0001/g, '<span class="parentheses-content">（');
        taggedHtml = taggedHtml.replace(/\u0001PAREN_END\u0001/g, '）</span>');
        
        return taggedHtml;
    }
    
    // 関連条文テキストノードを処理
    function processRelatedTextNode(textNode, pattern, lawName, currentMainNum, currentSubNum, currentParagraphNum, context) {
        const text = textNode.textContent;
        pattern.lastIndex = 0;
        
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        
        // 文脈から引き継ぐ（テキストノード間で維持）
        let lastReferencedArticle = context.lastReferencedArticle;
        let lastReferencedParagraph = context.lastReferencedParagraph;
        let lastReferenceOffset = context.lastReferenceOffset;
        let lastExplicitArticle = context.lastExplicitArticle;
        let lastExplicitParagraph = context.lastExplicitParagraph;
        let lastExplicitOffset = context.lastExplicitOffset;
        let lastTreatyArticle = context.lastTreatyArticle;
        let lastTreatyOffset = context.lastTreatyOffset;
        const baseParenDepth = context.parenDepth || 0;
        const baseQuoteDepth = context.quoteDepth || 0;
        const baseTailText = context.tailText || '';
        const baseOffset = context.totalLength || 0;

        // マッチがない場合でも、括弧・鉤括弧の深さと末尾テキストは更新する
        if (!pattern.test(text)) {
            context.parenDepth = getDepthAfter(text, baseParenDepth, /[（(]/g, /[）)]/g);
            context.quoteDepth = getDepthAfter(text, baseQuoteDepth, /「/g, /」/g);
            context.tailText = (baseTailText + text).slice(-500);
            context.totalLength = baseOffset + text.length;
            return;
        }
        pattern.lastIndex = 0;
        
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const matchText = match[0];
            let targetArticle = null;
            let explicitFullRef = null;
            
            const beforeMatch = text.slice(0, match.index);
            const parenDepth = getDepthAfter(beforeMatch, baseParenDepth, /[（(]/g, /[）)]/g);
            const quoteDepth = getDepthAfter(beforeMatch, baseQuoteDepth, /「/g, /」/g);
            const isInParentheses = parenDepth > 0;
            const isInQuotes = quoteDepth > 0;
            const combinedTail = (baseTailText + beforeMatch).slice(-500);
            const isAfterConjunction = /(?:又は|若しくは|及び|並びに|、)\s*$/.test(combinedTail);
            const globalPos = baseOffset + match.index;
            const treatyTail = (baseTailText + beforeMatch).slice(-50);
            const isTreatyContext = isTreatyReferenceForMatch(treatyTail, matchText, lastTreatyOffset, globalPos);
            
            // マッチした参照から条文部分を抽出して解決
            // 例: 「前条第三項」→「前条」部分を解析、「第四十三条の二第二項」→「第四十三条の二」を解析
            // 「第三号」のように項・号のみの場合は直前の条文または同条への参照
            const articleMatch = matchText.match(/^(第[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?|前条|次条|同条)/);
            // 項の抽出
            const paragraphMatch = matchText.match(/第[一二三四五六七八九十0-9０-９]+項/);
            
            if (articleMatch) {
                const articleRef = articleMatch[1];
                
                if (articleRef.startsWith('第') && articleRef.includes('条')) {
                    if (isTreatyContext) {
                        // 条約参照はリンク化しない
                        lastTreatyArticle = articleRef;
                        lastTreatyOffset = globalPos;
                    } else {
                    // 「第○条」または「第○条の○」
                    targetArticle = articleRef;
                    lastReferencedArticle = articleRef;  // 記憶
                    lastReferencedParagraph = paragraphMatch ? paragraphMatch[0] : null;  // 項も記憶
                    lastReferenceOffset = globalPos;
                    lastExplicitArticle = articleRef;
                    lastExplicitParagraph = paragraphMatch ? paragraphMatch[0] : null;
                    lastExplicitOffset = globalPos;
                    }
                } else if (articleRef === '前条' && currentMainNum > 1) {
                    if (isTreatyContext) {
                        lastTreatyArticle = articleRef;
                        lastTreatyOffset = globalPos;
                    } else {
                    const prevNum = currentMainNum - 1;
                    targetArticle = `第${numToKanji(prevNum)}条`;
                    lastReferencedArticle = targetArticle;  // 記憶
                    lastReferencedParagraph = paragraphMatch ? paragraphMatch[0] : null;
                    lastReferenceOffset = globalPos;
                    }
                } else if (articleRef === '次条') {
                    if (isTreatyContext) {
                        lastTreatyArticle = articleRef;
                        lastTreatyOffset = globalPos;
                    } else {
                    const nextNum = currentMainNum + 1;
                    targetArticle = `第${numToKanji(nextNum)}条`;
                    lastReferencedArticle = targetArticle;  // 記憶
                    lastReferencedParagraph = paragraphMatch ? paragraphMatch[0] : null;
                    lastReferenceOffset = globalPos;
                    }
                } else if (articleRef === '同条') {
                    if (isTreatyContext) {
                        lastTreatyArticle = articleRef;
                        lastTreatyOffset = globalPos;
                    } else {
                    targetArticle = `第${numToKanji(currentMainNum)}条${currentSubNum ? 'の' + numToKanji(currentSubNum) : ''}`;
                    lastReferencedArticle = targetArticle;  // 記憶
                    lastReferencedParagraph = paragraphMatch ? paragraphMatch[0] : null;
                    lastReferenceOffset = globalPos;
                    }
                }
            } else if (matchText === '前項' || matchText === '次項' || matchText === '同項') {
                if (isTreatyContext) {
                    // 条約参照の直後はリンク化しない
                    targetArticle = null;
                } else if (currentMainNum && currentParagraphNum) {
                    let targetParagraph = currentParagraphNum;
                    if (matchText === '前項' && currentParagraphNum > 1) {
                        targetParagraph = currentParagraphNum - 1;
                    } else if (matchText === '次項') {
                        targetParagraph = currentParagraphNum + 1;
                    }
                    targetArticle = `第${numToKanji(currentMainNum)}条${currentSubNum ? 'の' + numToKanji(currentSubNum) : ''}`;
                    explicitFullRef = `${targetArticle}第${numToKanji(targetParagraph)}項`;
                }
            } else if (matchText.match(/^第[一二三四五六七八九十0-9０-９]+項/)) {
                // 「第○項」のみの場合
                const isNearLastRef = lastReferenceOffset !== null && (globalPos - lastReferenceOffset) <= 120;
                const isNearExplicit = lastExplicitOffset !== null && (globalPos - lastExplicitOffset) <= 200;
                // 文脈テキストから直前の条文参照を拾う
                const contextText = (baseTailText + beforeMatch).slice(-500);
                const foundRef = findLastArticleRef(contextText);
                if ((!lastExplicitArticle || isNearExplicit === false) && foundRef) {
                    lastExplicitArticle = foundRef.article;
                    lastExplicitParagraph = foundRef.paragraph;
                    lastExplicitOffset = globalPos - 1;
                }
                const baseArticle = lastExplicitArticle || lastReferencedArticle;
                const baseParagraph = lastExplicitParagraph || lastReferencedParagraph;
                if (!isTreatyContext && baseArticle && (isInParentheses || isInQuotes || isAfterConjunction || isNearLastRef || isNearExplicit)) {
                    targetArticle = baseArticle;
                    // この項を記憶（後続の号で使用）
                    lastReferencedParagraph = matchText.match(/第[一二三四五六七八九十0-9０-９]+項/)?.[0] || null;
                } else if (currentMainNum) {
                    targetArticle = `第${numToKanji(currentMainNum)}条${currentSubNum ? 'の' + numToKanji(currentSubNum) : ''}`;
                    lastReferencedParagraph = matchText.match(/第[一二三四五六七八九十0-9０-９]+項/)?.[0] || null;
                }
            } else if (matchText.match(/^第[一二三四五六七八九十0-9０-９]+号/)) {
                // 「第○号」のみの場合
                // 直前に条文参照があり、以下のいずれかの場合はその条文を使用：
                // 1. 括弧内にいる
                // 2. 鉤括弧内にいる（読み替え規定など）
                // 3. 接続詞の直後
                const isNearLastRef = lastReferenceOffset !== null && (globalPos - lastReferenceOffset) <= 120;
                const isNearExplicit = lastExplicitOffset !== null && (globalPos - lastExplicitOffset) <= 200;
                // 文脈テキストから直前の条文参照を拾う
                const contextText = (baseTailText + beforeMatch).slice(-500);
                const foundRef = findLastArticleRef(contextText);
                if ((!lastExplicitArticle || isNearExplicit === false) && foundRef) {
                    lastExplicitArticle = foundRef.article;
                    lastExplicitParagraph = foundRef.paragraph;
                    lastExplicitOffset = globalPos - 1;
                }
                const baseArticle = lastExplicitArticle || lastReferencedArticle;
                const baseParagraph = lastExplicitParagraph || lastReferencedParagraph;
                if (!isTreatyContext && baseArticle && (isInParentheses || isInQuotes || isAfterConjunction || isNearLastRef || isNearExplicit)) {
                    targetArticle = baseArticle;
                    // 記憶した項があれば fullRef に含める
                } else if (currentMainNum) {
                    targetArticle = `第${numToKanji(currentMainNum)}条${currentSubNum ? 'の' + numToKanji(currentSubNum) : ''}`;
                }
            }
            
            if (targetArticle) {
                const link = document.createElement('span');
                link.className = 'law-ref-internal';
                link.textContent = matchText;
                link.dataset.law = lawName;
                link.dataset.article = targetArticle;
                // 完全な参照（項・号含む）を保持してハイライトに使用
                // 記憶した項があれば追加
                const contextParagraph = lastExplicitParagraph || lastReferencedParagraph;
                link.dataset.fullRef = explicitFullRef || buildFullRefWithContext(targetArticle, matchText, contextParagraph);
                link.title = `${lawName}${targetArticle}を表示`;
                fragment.appendChild(link);
            } else {
                fragment.appendChild(document.createTextNode(matchText));
            }
            
            lastIndex = pattern.lastIndex;
        }

        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        if (fragment.childNodes.length > 0 && textNode.parentNode) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
        
        // 文脈を次のテキストノードに引き継ぐ
        context.lastReferencedArticle = lastReferencedArticle;
        context.lastReferencedParagraph = lastReferencedParagraph;
        context.lastReferenceOffset = lastReferenceOffset;
        context.lastExplicitArticle = lastExplicitArticle;
        context.lastExplicitParagraph = lastExplicitParagraph;
        context.lastExplicitOffset = lastExplicitOffset;
        context.lastTreatyArticle = lastTreatyArticle;
        context.lastTreatyOffset = lastTreatyOffset;
        context.parenDepth = getDepthAfter(text, baseParenDepth, /[（(]/g, /[）)]/g);
        context.quoteDepth = getDepthAfter(text, baseQuoteDepth, /「/g, /」/g);
        context.tailText = (baseTailText + text).slice(-500);
        context.totalLength = baseOffset + text.length;
    }
    
    // 数字を漢数字に変換
    function numToKanji(num) {
        const kanjiDigits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        const units = ['', '十', '百', '千'];
        
        if (num === 0) return '〇';
        if (num < 10) return kanjiDigits[num];
        if (num < 100) {
            const tens = Math.floor(num / 10);
            const ones = num % 10;
            return (tens === 1 ? '' : kanjiDigits[tens]) + '十' + (ones === 0 ? '' : kanjiDigits[ones]);
        }
        if (num < 1000) {
            const hundreds = Math.floor(num / 100);
            const rest = num % 100;
            return (hundreds === 1 ? '' : kanjiDigits[hundreds]) + '百' + (rest === 0 ? '' : numToKanji(rest));
        }
        return String(num);
    }
    
    // 完全な参照文字列を構築（条文 + 項・号）
    function buildFullRef(targetArticle, matchText) {
        // matchTextから項・号を抽出してtargetArticleに追加
        const paraMatch = matchText.match(/第[一二三四五六七八九十0-9０-９]+項/);
        const itemMatch = matchText.match(/第[一二三四五六七八九十0-9０-９]+号/);
        
        let fullRef = targetArticle;
        if (paraMatch) fullRef += paraMatch[0];
        if (itemMatch) fullRef += itemMatch[0];
        
        return fullRef;
    }
    
    // 文脈を考慮した完全な参照文字列を構築
    function buildFullRefWithContext(targetArticle, matchText, contextParagraph) {
        // matchTextに項が含まれていればそれを使用、なければ文脈から取得
        const paraMatch = matchText.match(/第[一二三四五六七八九十0-9０-９]+項/);
        const itemMatch = matchText.match(/第[一二三四五六七八九十0-9０-９]+号/);
        
        let fullRef = targetArticle;
        
        // 項: matchTextに含まれていればそれを使用、なければ文脈の項を使用
        if (paraMatch) {
            fullRef += paraMatch[0];
        } else if (contextParagraph && itemMatch) {
            // 号のみの場合で、文脈に項があればそれを使用
            fullRef += contextParagraph;
        }
        
        if (itemMatch) fullRef += itemMatch[0];
        
        return fullRef;
    }

    // 深さを計算（括弧や鉤括弧の開閉）
    function getDepthAfter(text, baseDepth, openRe, closeRe) {
        const openCount = (text.match(openRe) || []).length;
        const closeCount = (text.match(closeRe) || []).length;
        return baseDepth + openCount - closeCount;
    }

    // 直前の条文参照（条 + 任意の項）をテキストから抽出
    function findLastArticleRef(text) {
        const pattern = /(第[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?)(第[一二三四五六七八九十0-9０-９]+項)?/g;
        let match;
        let last = null;
        while ((match = pattern.exec(text)) !== null) {
            last = {
                article: match[1],
                paragraph: match[2] || null
            };
        }
        return last;
    }

    // 条約参照かどうかを判定（直前のテキストから判断）
    function isTreatyReferenceForMatch(textTail, matchText, lastTreatyOffset, globalPos) {
        const treatyTerms = [
            'パリ条約',
            '工業所有権の保護に関するパリ条約',
            '特許協力条約',
            'ジュネーブ改正協定',
            'マドリッドで採択された議定書',
            'マドリッド協定議定書',
            'マドリッド議定書',
            '条約'
        ];
        
        // 括弧内のテキストを除去してからチェック（「（...）」や「(...)」を除去）
        let cleanedTail = textTail.replace(/[（(][^）)]*[）)]/g, '');
        
        // 直前のテキストが条約用語で終わっている場合は条約参照
        for (const term of treatyTerms) {
            if (cleanedTail.endsWith(term) || cleanedTail.endsWith(`${term}の`) || cleanedTail.endsWith(`${term}第`)) {
                return true;
            }
        }
        
        // 接続詞（又は、若しくは、及び、並びに、、）で終わっていて、
        // かつテキスト内に条約用語+条文番号のパターンがある場合も条約参照
        const endsWithConjunction = /(?:又は|若しくは|及び|並びに|、)\s*$/.test(cleanedTail);
        if (endsWithConjunction) {
            for (const term of treatyTerms) {
                // 条約用語の後に条文番号がある（例：「条約第十一条」）
                const treatyArticlePattern = new RegExp(term + '第[一二三四五六七八九十百千0-9０-９]+条');
                if (treatyArticlePattern.test(cleanedTail)) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    // 文字列が括弧内にあるかどうかを判定
    function isInsideParentheses(textBefore) {
        // 開き括弧と閉じ括弧の数をカウント（全角・半角両方）
        const openCount = (textBefore.match(/[（(]/g) || []).length;
        const closeCount = (textBefore.match(/[）)]/g) || []).length;
        // 開き括弧が閉じ括弧より多ければ、括弧内にいる
        return openCount > closeCount;
    }
    
    // 文字列が鉤括弧内にあるかどうかを判定（読み替え規定など）
    function isInsideQuotes(textBefore) {
        // 開き鉤括弧と閉じ鉤括弧の数をカウント
        const openCount = (textBefore.match(/「/g) || []).length;
        const closeCount = (textBefore.match(/」/g) || []).length;
        // 開き鉤括弧が閉じ鉤括弧より多ければ、鉤括弧内にいる
        return openCount > closeCount;
    }

    // テキストノードを処理して法令参照をマークアップ
    function processTextNode(textNode) {
        const text = textNode.textContent;
        
        // 毎回新しいパターンを作成してlastIndex問題を回避
        const pattern = new RegExp(
            `(${LAW_NAMES}|${LAW_ABBREVS})(第?[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?(?:第?[一二三四五六七八九十0-9０-９]+項)?(?:第?[一二三四五六七八九十0-9０-９]+号)?)`,
            'g'
        );
        
        if (!pattern.test(text)) return;
        pattern.lastIndex = 0;
        
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = pattern.exec(text)) !== null) {
            // マッチ前のテキスト
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            // 法令参照をspan要素でラップ
            const span = document.createElement('span');
            span.className = 'law-ref-highlight';
            span.textContent = match[0];
            span.dataset.law = match[1];
            span.dataset.article = match[2];
            
            span.addEventListener('mouseenter', handleMouseEnter);
            
            fragment.appendChild(span);
            lastIndex = pattern.lastIndex;
        }

        // 残りのテキスト
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        textNode.parentNode.replaceChild(fragment, textNode);
    }

    // DOMを走査してテキストノードを処理
    function processDocument() {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    // スクリプト、スタイル、入力要素内は除外
                    const parent = node.parentNode;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    
                    const tagName = parent.tagName;
                    if (tagName === 'SCRIPT' || tagName === 'STYLE' || 
                        tagName === 'TEXTAREA' || tagName === 'INPUT' ||
                        tagName === 'NOSCRIPT' || tagName === 'IFRAME') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    
                    // 既に処理済みの要素は除外
                    if (parent.classList && parent.classList.contains('law-ref-highlight')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    
                    // 空白のみのノードは除外
                    if (!node.textContent.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        textNodes.forEach(processTextNode);
    }

    // マウスエンター時の処理
    async function handleMouseEnter(event) {
        const target = event.target;
        currentHighlight = target;  // 現在ホバー中の要素を記録
        
        const lawName = target.dataset.law;
        const articleNum = target.dataset.article;

        const popup = createPopup();

        // ポップアップを一旦表示して実際のサイズを取得
        popup.style.visibility = 'hidden';
        popup.classList.add('active');
        
        const popupWidth = popup.offsetWidth || 450;
        const popupHeight = popup.offsetHeight || 350;
        
        // 位置を計算
        const rect = target.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // 横位置: 画面からはみ出さないように調整
        let left = rect.left;
        if (left + popupWidth > viewportWidth - 20) {
            left = viewportWidth - popupWidth - 20;
        }
        if (left < 10) {
            left = 10;
        }
        
        // 縦位置: 下に収まらなければ上に表示
        let top;
        if (rect.bottom + popupHeight + 20 > viewportHeight) {
            // 上に表示
            top = rect.top - popupHeight - 10;
            if (top < 10) {
                top = 10;
            }
        } else {
            // 下に表示
            top = rect.bottom + 10;
        }
        
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.visibility = 'visible';

        // 履歴をリセットして最初の条文を表示
        articleHistory = [];
        await navigateToArticle(lawName, articleNum, articleNum, false);
    }

    // e-Gov由来のHTMLをサニタイズ（許可リスト方式）
    function sanitizeArticleHtml(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        // 許可するタグ（最小限）
        const allowedTags = new Set([
            'P', 'DIV', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U',
            'BR', 'UL', 'OL', 'LI', 'A'
        ]);

        // 許可するstyleプロパティ（ハイライト用）
        const allowedStyleProps = new Set([
            'background-color', 'border-left', 'padding-left', 'margin-left'
        ]);

        const elements = doc.body.querySelectorAll('*');
        elements.forEach((el) => {
            const tagName = el.tagName;

            if (!allowedTags.has(tagName)) {
                // 許可されないタグはテキストに置換
                const textNode = doc.createTextNode(el.textContent || '');
                el.replaceWith(textNode);
                return;
            }

            // style属性のみ安全な値を許可、他の属性は削除（Aタグのhref等は別途復元）
            const styleAttr = el.getAttribute('style');
            const hrefAttr = el.getAttribute('href');
            const targetAttr = el.getAttribute('target');
            const relAttr = el.getAttribute('rel');
            [...el.attributes].forEach((attr) => {
                el.removeAttribute(attr.name);
            });
            
            // 安全なstyleプロパティのみ復元
            if (styleAttr) {
                const safeStyles = [];
                styleAttr.split(';').forEach(prop => {
                    const [name, value] = prop.split(':').map(s => s.trim());
                    if (name && value && allowedStyleProps.has(name.toLowerCase())) {
                        // 値が安全かチェック（url()やjavascript:を除外）
                        const lowerValue = value.toLowerCase();
                        if (!lowerValue.includes('url(') && 
                            !lowerValue.includes('javascript:') &&
                            !lowerValue.includes('expression(')) {
                            safeStyles.push(`${name}: ${value}`);
                        }
                    }
                });
                if (safeStyles.length > 0) {
                    el.setAttribute('style', safeStyles.join('; '));
                }
            }

            // Aタグのhref/target/relを安全な場合のみ復元
            if (tagName === 'A' && hrefAttr) {
                try {
                    const url = new URL(hrefAttr, window.location.origin);
                    if (url.protocol === 'https:' && url.hostname === 'laws.e-gov.go.jp') {
                        el.setAttribute('href', url.href);
                        if (targetAttr === '_blank') {
                            el.setAttribute('target', '_blank');
                        }
                        if (relAttr && /noopener/i.test(relAttr)) {
                            el.setAttribute('rel', 'noopener noreferrer');
                        } else {
                            el.setAttribute('rel', 'noopener noreferrer');
                        }
                    }
                } catch (e) {
                    // 不正なURLは無視
                }
            }
        });

        return doc.body.innerHTML;
    }

    // ポップアップ内の法令参照をオフラインで処理（DOMに追加する前）
    function processPopupContentOffline(htmlString) {
        // 一時的なDIV要素を作成（DOMには追加しない）
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        
        // ポップアップ内用に新しい正規表現を作成（グローバルフラグの lastIndex 問題を回避）
        const popupLawPattern = new RegExp(
            `(${LAW_NAMES}|${LAW_ABBREVS})(第?[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?(?:第?[一二三四五六七八九十0-9０-９]+項)?(?:第?[一二三四五六七八九十0-9０-９]+号)?)`,
            'g'
        );
        
        // テキストノードを収集
        const walker = document.createTreeWalker(
            tempDiv,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    const parent = node.parentNode;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    const tagName = parent.tagName;
                    if (tagName === 'A') return NodeFilter.FILTER_REJECT;  // リンク内は除外
                    if (!node.textContent.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        textNodes.forEach(textNode => processPopupTextNode(textNode, popupLawPattern));
        
        // 処理済みのHTMLを返す
        return tempDiv.innerHTML;
    }

    // ポップアップ内のテキストノードを処理（e-Govへの外部リンクを生成）
    function processPopupTextNode(textNode, pattern) {
        const text = textNode.textContent;
        
        // パターンをリセット
        pattern.lastIndex = 0;
        
        if (!pattern.test(text)) return;
        
        // test() が lastIndex を進めるので再度リセット
        pattern.lastIndex = 0;
        
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = pattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            // e-GovへのURLを生成
            const lawName = match[1];
            const articleNum = match[2];
            const eGovUrl = generateEGovUrl(lawName, articleNum);
            
            // 外部リンクとしてマークアップ
            const link = document.createElement('a');
            link.href = eGovUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = match[0];
            link.style.cssText = 'color: #1a73e8 !important; text-decoration: underline !important; cursor: pointer !important; pointer-events: auto !important;';
            link.title = 'e-Govで開く（新しいタブ）';
            
            fragment.appendChild(link);
            lastIndex = pattern.lastIndex;
        }

        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        if (fragment.childNodes.length > 0 && textNode.parentNode) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
    }
    
    // e-GovのURLを生成
    function generateEGovUrl(lawName, articleNum) {
        // 略称を正式名称に変換
        const fullLawName = LAW_ABBREVIATIONS[lawName] || lawName;
        const lawId = LAW_IDS[fullLawName];
        
        if (!lawId) {
            // 法令IDが見つからない場合は検索ページへ
            return `https://laws.e-gov.go.jp/search/elawsSearch/elaws_search/lsg0100/`;
        }
        
        // 条番号を解析
        const articleNumMatch = articleNum.match(/第?([一二三四五六七八九十百千0-9０-９]+)条(?:の([一二三四五六七八九十0-9０-９]+))?/);
        if (!articleNumMatch) {
            return `https://laws.e-gov.go.jp/law/${lawId}`;
        }
        
        const mainNum = convertToNumber(articleNumMatch[1]);
        const subNum = articleNumMatch[2] ? convertToNumber(articleNumMatch[2]) : null;
        
        // e-Govの条文アンカー形式: #MP-At_条番号 または #MP-At_条番号_枝番号
        const articleAnchor = subNum ? `${mainNum}_${subNum}` : `${mainNum}`;
        
        return `https://laws.e-gov.go.jp/law/${lawId}#MP-At_${articleAnchor}`;
    }

    // マウスリーブ時の処理
    // 漢数字を数字に変換
    function convertToNumber(str) {
        const kanjiNums = {
            '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4,
            '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
            '十': 10, '百': 100, '千': 1000
        };

        // 全角数字を半角に変換
        str = str.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));

        // 既に数字の場合
        if (/^\d+$/.test(str)) {
            return parseInt(str, 10);
        }

        // 漢数字を変換
        let result = 0;
        let temp = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            const num = kanjiNums[char];

            if (num === undefined) continue;

            if (num >= 10) {
                if (temp === 0) temp = 1;
                result += temp * num;
                temp = 0;
            } else {
                temp = temp * 10 + num;
            }
        }

        return result + temp;
    }

    // e-Gov APIから条文を取得
    async function fetchArticle(lawName, articleNum) {
        // 略称を正式名称に変換
        const fullLawName = LAW_ABBREVIATIONS[lawName] || lawName;
        
        const cacheKey = `${fullLawName}${articleNum}`;

        // キャッシュを確認
        if (articleCache[cacheKey]) {
            return articleCache[cacheKey];
        }

        const lawId = LAW_IDS[fullLawName];
        if (!lawId) {
            throw new Error(`${lawName}の法令IDが登録されていません`);
        }


        // 条番号を変換（「第」は省略可能、号にも対応）
        const articleNumMatch = articleNum.match(/第?([一二三四五六七八九十百千0-9０-９]+)条(?:の([一二三四五六七八九十0-9０-９]+))?(?:第?([一二三四五六七八九十0-9０-９]+)項)?(?:第?([一二三四五六七八九十0-9０-９]+)号)?/);
        if (!articleNumMatch) {
            throw new Error('条番号の解析に失敗しました');
        }

        const mainNum = convertToNumber(articleNumMatch[1]);
        const subNum = articleNumMatch[2] ? convertToNumber(articleNumMatch[2]) : null;
        const paragraphNum = articleNumMatch[3] ? convertToNumber(articleNumMatch[3]) : null;
        const itemNum = articleNumMatch[4] ? convertToNumber(articleNumMatch[4]) : null;

        try {
            // e-Gov API呼び出し
            const apiUrl = `https://laws.e-gov.go.jp/api/1/articles;lawId=${lawId};article=${mainNum}${subNum ? `_${subNum}` : ''}`;
            
            const response = await fetch(apiUrl);
            
            if (response.ok) {
                const xmlText = await response.text();
                const result = parseArticleXml(xmlText, fullLawName, articleNum, lawId, paragraphNum, itemNum);
                addToCache(cacheKey, result);
                return result;
            } else {
                return getMockArticle(lawName, articleNum, lawId, paragraphNum, itemNum);
            }
        } catch (error) {
            // API呼び出しエラー時はモックデータを使用
            return getMockArticle(lawName, articleNum, lawId, paragraphNum, itemNum);
        }
    }

    // XMLをパース
    function parseArticleXml(xmlText, lawName, articleNum, lawId, highlightParagraph, highlightItem) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

            const articles = xmlDoc.getElementsByTagName('Article');
            if (articles.length === 0) {
                throw new Error('条文が見つかりません');
            }

            let content = '';
            let paragraphIndex = 0;
            
            for (let article of articles) {
                // 条見出し（例：（特許を受ける権利））
                const caption = article.getElementsByTagName('ArticleCaption')[0];
                if (caption) {
                    content += `<strong>${caption.textContent}</strong>`;
                }

                // 各項を処理
                const paragraphs = article.getElementsByTagName('Paragraph');
                for (let para of paragraphs) {
                    paragraphIndex++;
                    
                    // 項番号を取得（例：２、３など）
                    const paragraphNumElem = para.getElementsByTagName('ParagraphNum')[0];
                    const numText = paragraphNumElem ? paragraphNumElem.textContent : '';
                    
                    // 指定された項かどうかを判定（ハイライト用）
                    const isParaHighlighted = highlightParagraph && paragraphIndex === highlightParagraph;
                    const paraHighlightStyle = isParaHighlighted && !highlightItem
                        ? 'background-color: #fff3cd; border-left: 3px solid #ffc107; padding-left: 8px; margin-left: -11px;' 
                        : '';
                    
                    // 項の文を全て取得（複数のSentence要素がある場合）
                    const sentences = para.getElementsByTagName('ParagraphSentence')[0];
                    let sentenceText = '';
                    if (sentences) {
                        const sentenceElements = sentences.getElementsByTagName('Sentence');
                        for (let sent of sentenceElements) {
                            sentenceText += sent.textContent;
                        }
                    }
                    
                    if (sentenceText) {
                        content += `<p style="${paraHighlightStyle}">${numText}　${sentenceText}</p>`;
                    }
                    
                    // 号（Item）を処理
                    const items = para.getElementsByTagName('Item');
                    let itemIndex = 0;
                    for (let item of items) {
                        itemIndex++;
                        const itemTitle = item.getElementsByTagName('ItemTitle')[0];
                        const itemSentence = item.getElementsByTagName('ItemSentence')[0];
                        
                        let itemText = '';
                        if (itemTitle) {
                            itemText += itemTitle.textContent + '　';
                        }
                        if (itemSentence) {
                            const itemSentElements = itemSentence.getElementsByTagName('Sentence');
                            for (let sent of itemSentElements) {
                                itemText += sent.textContent;
                            }
                        }
                        
                        if (itemText) {
                            // 号のハイライト判定（項も一致している必要がある）
                            const isItemHighlighted = isParaHighlighted && highlightItem && itemIndex === highlightItem;
                            const itemHighlightStyle = isItemHighlighted
                                ? 'margin-left: 1.5em; background-color: #fff3cd; border-left: 3px solid #ffc107; padding-left: 8px;'
                                : (isParaHighlighted && !highlightItem ? 'margin-left: 1.5em; background-color: #fff3cd;' : 'margin-left: 1.5em;');
                            content += `<p style="${itemHighlightStyle}">${itemText}</p>`;
                        }
                    }
                }
            }

            return content;
        } catch (error) {
            throw new Error('XMLの解析に失敗しました');
        }
    }


    // モックデータ（API失敗時のフォールバック）
    function getMockArticle(lawName, articleNum, lawId, paragraphNum, itemNum) {
        const mockData = {
            '特許法第1条': `<strong>（目的）</strong>
                <p>この法律は、発明の保護及び利用を図ることにより、発明を奨励し、もつて産業の発達に寄与することを目的とする。</p>`,
            '特許法第2条': `<strong>（定義）</strong>
                <p>この法律で「発明」とは、自然法則を利用した技術的思想の創作のうち高度のものをいう。</p>
                <p>２　この法律で「特許発明」とは、特許を受けている発明をいう。</p>
                <p>３　この法律で発明について「実施」とは、次に掲げる行為をいう。</p>`,
            '特許法第29条': `<strong>（特許の要件）</strong>
                <p>産業上利用することができる発明をした者は、次に掲げる発明を除き、その発明について特許を受けることができる。</p>
                <p>一　特許出願前に日本国内又は外国において公然知られた発明</p>
                <p>二　特許出願前に日本国内又は外国において公然実施をされた発明</p>
                <p>三　特許出願前に日本国内又は外国において、頒布された刊行物に記載された発明又は電気通信回線を通じて公衆に利用可能となつた発明</p>`,
            '特許法第29条第2項': `<strong>（特許の要件）</strong>
                <p>２　特許出願前にその発明の属する技術の分野における通常の知識を有する者が前項各号に掲げる発明に基いて容易に発明をすることができたときは、その発明については、同項の規定にかかわらず、特許を受けることができない。</p>`,
            '特許法第36条': `<strong>（特許出願）</strong>
                <p>特許を受けようとする者は、次に掲げる事項を記載した願書を特許庁長官に提出しなければならない。</p>
                <p>一　特許出願人の氏名又は名称及び住所又は居所</p>
                <p>二　発明者の氏名及び住所又は居所</p>`,
            '特許法第70条': `<strong>（特許発明の技術的範囲）</strong>
                <p>特許発明の技術的範囲は、願書に添付した特許請求の範囲の記載に基づいて定めなければならない。</p>
                <p>２　前項の場合においては、願書に添付した明細書の記載及び図面を考慮して、特許請求の範囲に記載された用語の意義を解釈するものとする。</p>`,
            '特許法第100条': `<strong>（差止請求権）</strong>
                <p>特許権者又は専用実施権者は、自己の特許権又は専用実施権を侵害する者又は侵害するおそれがある者に対し、その侵害の停止又は予防を請求することができる。</p>`,
            '特許法第102条': `<strong>（損害の額の推定等）</strong>
                <p>特許権者又は専用実施権者が故意又は過失により自己の特許権又は専用実施権を侵害した者に対しその侵害により自己が受けた損害の賠償を請求する場合において、その者がその侵害の行為を組成した物を譲渡したときは、次の各号に掲げる額の合計額を、特許権者又は専用実施権者が受けた損害の額とすることができる。</p>`,
            '民法第1条': `<strong>（基本原則）</strong>
                <p>私権は、公共の福祉に適合しなければならない。</p>
                <p>２　権利の行使及び義務の履行は、信義に従い誠実に行わなければならない。</p>
                <p>３　権利の濫用は、これを許さない。</p>`,
            '民法第90条': `<strong>（公序良俗）</strong>
                <p>公の秩序又は善良の風俗に反する法律行為は、無効とする。</p>`,
            '民法第709条': `<strong>（不法行為による損害賠償）</strong>
                <p>故意又は過失によって他人の権利又は法律上保護される利益を侵害した者は、これによって生じた損害を賠償する責任を負う。</p>`,
            '著作権法第1条': `<strong>（目的）</strong>
                <p>この法律は、著作物並びに実演、レコード、放送及び有線放送に関し著作者の権利及びこれに隣接する権利を定め、これらの文化的所産の公正な利用に留意しつつ、著作者等の権利の保護を図り、もつて文化の発展に寄与することを目的とする。</p>`,
            '著作権法第2条': `<strong>（定義）</strong>
                <p>この法律において、次の各号に掲げる用語の意義は、当該各号に定めるところによる。</p>
                <p>一　著作物　思想又は感情を創作的に表現したものであつて、文芸、学術、美術又は音楽の範囲に属するものをいう。</p>`,
            '商標法第1条': `<strong>（目的）</strong>
                <p>この法律は、商標を保護することにより、商標の使用をする者の業務上の信用の維持を図り、もつて産業の発達に寄与し、あわせて需要者の利益を保護することを目的とする。</p>`,
            '意匠法第1条': `<strong>（目的）</strong>
                <p>この法律は、意匠の保護及び利用を図ることにより、意匠の創作を奨励し、もつて産業の発達に寄与することを目的とする。</p>`,
            '実用新案法第1条': `<strong>（目的）</strong>
                <p>この法律は、物品の形状、構造又は組合せに係る考案の保護及び利用を図ることにより、その考案を奨励し、もつて産業の発達に寄与することを目的とする。</p>`,
            '会社法第1条': `<strong>（趣旨）</strong>
                <p>会社の設立、組織、運営及び管理については、他の法律に特別の定めがある場合を除くほか、この法律の定めるところによる。</p>`,
            '不正競争防止法第1条': `<strong>（目的）</strong>
                <p>この法律は、事業者間の公正な競争及びこれに関する国際約束の的確な実施を確保するため、不正競争の防止及び不正競争に係る損害賠償に関する措置等を講じ、もって国民経済の健全な発展に寄与することを目的とする。</p>`,
            '不正競争防止法第2条': `<strong>（定義）</strong>
                <p>この法律において「不正競争」とは、次に掲げるものをいう。</p>
                <p>一　他人の商品等表示（人の業務に係る氏名、商号、商標、標章、商品の容器若しくは包装その他の商品又は営業を表示するものをいう。以下同じ。）として需要者の間に広く認識されているものと同一若しくは類似の商品等表示を使用し、又はその商品等表示を使用した商品を譲渡し、引き渡し、譲渡若しくは引渡しのために展示し、輸出し、輸入し、若しくは電気通信回線を通じて提供して、他人の商品又は営業と混同を生じさせる行為</p>`,
        };

        const key = `${lawName}${articleNum}`;
        let content = mockData[key];

        if (!content) {
            content = `<p style="color: #666;">この条文のデータは現在登録されていません。</p>
                <p style="color: #666;">e-Gov法令検索で直接ご確認ください。</p>`;
        }

        // e-Gov法令検索へのリンクを追加
        if (lawId) {
            content += `<p style="margin-top: 12px; font-size: 12px;"><a href="https://laws.e-gov.go.jp/law/${lawId}" target="_blank" rel="noopener noreferrer" style="color: #1a73e8;">e-Gov法令検索で全文を見る →</a></p>`;
        }
        return content;
    }

    // MutationObserverで動的コンテンツも処理
    function observeDOM() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // 新しく追加された要素内のテキストノードを処理
                        const walker = document.createTreeWalker(
                            node,
                            NodeFilter.SHOW_TEXT,
                            null
                        );
                        const textNodes = [];
                        let textNode;
                        while (textNode = walker.nextNode()) {
                            if (textNode.parentNode.tagName !== 'SCRIPT' &&
                                textNode.parentNode.tagName !== 'STYLE' &&
                                !textNode.parentNode.classList.contains('law-ref-highlight')) {
                                textNodes.push(textNode);
                            }
                        }
                        textNodes.forEach(processTextNode);
                    }
                });
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 現在のサイトが除外リストに含まれているかチェック
    function isExcludedSite(excludedSites) {
        if (!excludedSites) return false;
        
        const currentHost = window.location.hostname;
        const patterns = excludedSites.split('\n').map(s => s.trim()).filter(s => s);
        
        for (const pattern of patterns) {
            // ワイルドカードパターンを正規表現に変換
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // 特殊文字をエスケープ
                .replace(/\*/g, '.*');  // * を .* に変換
            
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            if (regex.test(currentHost)) {
                return true;
            }
        }
        return false;
    }

    // 初期化
    async function init() {
        // 設定を読み込み
        try {
            const settings = await chrome.storage.sync.get({
                enabled: true,
                excludedSites: ''
            });
            
            // 無効化されている場合は処理しない
            if (!settings.enabled) {
                return;
            }
            
            // 除外サイトの場合は処理しない
            if (isExcludedSite(settings.excludedSites)) {
                return;
            }
        } catch (error) {
            // storage APIが使えない場合はデフォルトで有効として続行
        }
        
        // ページ読み込み完了後に実行
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                processDocument();
                observeDOM();
            });
        } else {
            processDocument();
            observeDOM();
        }
        
        // フローティングボタンを作成（設定に応じて）
        // 設定がundefinedの場合はtrueとして扱う
        chrome.storage.sync.get(['showFloatingBtn'], (settings) => {
            const shouldShow = settings.showFloatingBtn !== false; // undefined or true = 表示
            if (shouldShow) {
                createFloatingButton();
            }
        });
        
        // 検索モーダルを作成
        createSearchModal();
    }

    // 検索モーダル
    let searchModal = null;

    // 検索モーダルを作成
    function createSearchModal() {
        if (searchModal) return;
        
        searchModal = document.createElement('div');
        searchModal.id = 'jyobun-search-modal';
        searchModal.innerHTML = `
            <div class="modal-content">
                <div class="resize-handle resize-n" data-dir="n"></div>
                <div class="resize-handle resize-s" data-dir="s"></div>
                <div class="resize-handle resize-e" data-dir="e"></div>
                <div class="resize-handle resize-w" data-dir="w"></div>
                <div class="resize-handle resize-ne" data-dir="ne"></div>
                <div class="resize-handle resize-nw" data-dir="nw"></div>
                <div class="resize-handle resize-se" data-dir="se"></div>
                <div class="resize-handle resize-sw" data-dir="sw"></div>
                <div class="modal-header">
                    <h2>📚 条文スタディ検索</h2>
                    <div class="modal-controls">
                        <button class="modal-minimize" title="畳む">─</button>
                        <button class="modal-close" title="閉じる">×</button>
                    </div>
                </div>
                <div class="modal-collapsible">
                    <div class="search-box">
                        <input type="text" class="search-input" placeholder="例: 特許法29条、民法709条">
                        <button class="search-btn">検索</button>
                    </div>
                    <div class="quick-links">
                        <button class="quick-link" data-law="特許法">特許法</button>
                        <button class="quick-link" data-law="実用新案法">実用新案法</button>
                        <button class="quick-link" data-law="意匠法">意匠法</button>
                        <button class="quick-link" data-law="商標法">商標法</button>
                        <button class="quick-link" data-law="著作権法">著作権法</button>
                        <button class="quick-link" data-law="不正競争防止法">不競法</button>
                        <button class="quick-link" data-law="憲法">憲法</button>
                        <button class="quick-link" data-law="民法">民法</button>
                        <button class="quick-link" data-law="商法">商法</button>
                        <button class="quick-link" data-law="民事訴訟法">民訴法</button>
                        <button class="quick-link" data-law="刑事訴訟法">刑訴法</button>
                    </div>
                    <div class="modal-body">
                        <div class="welcome">
                            <div class="welcome-icon">📖</div>
                            <p>上の検索ボックスに法令参照を入力してください。<br>例：「特許法29条」「民法第709条」</p>
                        </div>
                    </div>
                    <div class="modal-footer">
                        © 2026 Hajime Kumami｜出典：<a href="https://laws.e-gov.go.jp/" target="_blank">e-Gov法令検索</a>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(searchModal);
        
        const modalContent = searchModal.querySelector('.modal-content');
        const modalHeader = searchModal.querySelector('.modal-header');
        const searchInput = searchModal.querySelector('.search-input');
        const searchBtn = searchModal.querySelector('.search-btn');
        const modalBody = searchModal.querySelector('.modal-body');
        const closeBtn = searchModal.querySelector('.modal-close');
        
        // ドラッグ機能
        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;
        
        modalHeader.addEventListener('mousedown', (e) => {
            if (e.target === closeBtn) return;
            if (e.target.closest('.modal-minimize')) return;
            isDragging = true;
            const rect = modalContent.getBoundingClientRect();
            // クリック位置とウィンドウ左上からのオフセットを記録
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            // transformを解除して現在位置を固定
            modalContent.style.left = rect.left + 'px';
            modalContent.style.top = rect.top + 'px';
            modalContent.style.transform = 'none';
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            // マウス位置からオフセットを引いた位置にウィンドウを配置
            modalContent.style.left = (e.clientX - offsetX) + 'px';
            modalContent.style.top = (e.clientY - offsetY) + 'px';
            modalContent.style.transform = 'none';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // リサイズ機能
        let isResizing = false;
        let resizeDir = '';
        let resizeStartX = 0;
        let resizeStartY = 0;
        let resizeStartWidth = 0;
        let resizeStartHeight = 0;
        let resizeStartLeft = 0;
        let resizeStartTop = 0;
        
        const resizeHandles = searchModal.querySelectorAll('.resize-handle');
        resizeHandles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                resizeDir = handle.dataset.dir || '';
                resizeStartX = e.clientX;
                resizeStartY = e.clientY;
                const rect = modalContent.getBoundingClientRect();
                resizeStartWidth = rect.width;
                resizeStartHeight = rect.height;
                resizeStartLeft = rect.left;
                resizeStartTop = rect.top;
                e.preventDefault();
                e.stopPropagation();
            });
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const dx = e.clientX - resizeStartX;
            const dy = e.clientY - resizeStartY;
            const minWidth = 300;
            const minHeight = 200;
            
            let newWidth = resizeStartWidth;
            let newHeight = resizeStartHeight;
            let newLeft = resizeStartLeft;
            let newTop = resizeStartTop;
            
            // 方向に応じてサイズ・位置を計算
            if (resizeDir.includes('e')) {
                newWidth = Math.max(minWidth, resizeStartWidth + dx);
            }
            if (resizeDir.includes('w')) {
                const potentialWidth = resizeStartWidth - dx;
                if (potentialWidth >= minWidth) {
                    newWidth = potentialWidth;
                    newLeft = resizeStartLeft + dx;
                }
            }
            if (resizeDir.includes('s')) {
                newHeight = Math.max(minHeight, resizeStartHeight + dy);
            }
            if (resizeDir.includes('n')) {
                const potentialHeight = resizeStartHeight - dy;
                if (potentialHeight >= minHeight) {
                    newHeight = potentialHeight;
                    newTop = resizeStartTop + dy;
                }
            }
            
            modalContent.style.width = newWidth + 'px';
            modalContent.style.height = newHeight + 'px';
            modalContent.style.left = newLeft + 'px';
            modalContent.style.top = newTop + 'px';
            modalContent.style.transform = 'none';
            modalContent.style.maxWidth = 'none';
        });
        
        document.addEventListener('mouseup', () => {
            isResizing = false;
        });
        
        // 最小化ボタン
        const minimizeBtn = searchModal.querySelector('.modal-minimize');
        const collapsible = searchModal.querySelector('.modal-collapsible');
        
        minimizeBtn.addEventListener('click', () => {
            modalContent.classList.toggle('minimized');
            if (modalContent.classList.contains('minimized')) {
                minimizeBtn.textContent = '□';
                minimizeBtn.title = '展開';
            } else {
                minimizeBtn.textContent = '─';
                minimizeBtn.title = '畳む';
            }
        });
        
        // 閉じるボタン
        closeBtn.addEventListener('click', () => {
            searchModal.classList.remove('active');
            // フローティングボタンを再表示
            const floatingBtn = document.getElementById('jyobun-floating-btn');
            if (floatingBtn) floatingBtn.style.setProperty('display', 'block', 'important');
        });
        
        // 背景クリックで閉じる動作は無効化（ユーザー要望）
        // searchModal.addEventListener('click', (e) => {
        //     if (e.target === searchModal) {
        //         searchModal.classList.remove('active');
        //     }
        // });
        
        // Escで閉じる動作は無効化（ユーザー要望）
        // document.addEventListener('keydown', (e) => {
        //     if (e.key === 'Escape' && searchModal.classList.contains('active')) {
        //         searchModal.classList.remove('active');
        //     }
        // });
        
        // 保留中の条番号
        let pendingArticleNum = null;
        
        // 条番号のみをパース（法令名なし）
        const parseArticleOnly = (text) => {
            const normalizedText = text.replace(/\s+/g, '').replace(/条の([一二三四五六七八九十0-9０-９]+)条/g, '条の$1');
            const pattern = /^第?([一二三四五六七八九十百千0-9０-９]+)条(?:の([一二三四五六七八九十0-9０-９]+))?(?:第?([一二三四五六七八九十0-9０-９]+)項)?(?:第?([一二三四五六七八九十0-9０-９]+)号)?$/;
            const match = normalizedText.match(pattern);
            if (match) {
                return normalizedText;
            }
            return null;
        };
        
        // 法令選択プロンプトを表示
        const showSelectLawPrompt = (articleNum) => {
            modalBody.innerHTML = `
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
            
            modalBody.querySelectorAll('.law-select-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const lawName = btn.dataset.law;
                    searchInput.value = lawName + pendingArticleNum;
                    pendingArticleNum = null;
                    doModalSearch();
                });
            });
        };
        
        // 検索実行
        const doModalSearch = () => {
            const text = searchInput.value.trim().replace(/\s+/g, '');
            if (!text) return;
            
            const parsed = parseLawReferenceFromText(text);
            if (parsed) {
                pendingArticleNum = null;
                showModalResult(parsed.lawName, parsed.articleNum, modalBody);
            } else {
                // 法令名なしの条番号かチェック
                const articleOnly = parseArticleOnly(text);
                if (articleOnly) {
                    pendingArticleNum = articleOnly;
                    showSelectLawPrompt(articleOnly);
                } else {
                    modalBody.innerHTML = `<div class="error">法令参照を認識できませんでした。「特許法29条」のような形式で入力してください。</div>`;
                }
            }
        };
        
        searchBtn.addEventListener('click', doModalSearch);
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') doModalSearch();
        });
        
        // クイックリンク
        searchModal.querySelectorAll('.quick-link').forEach(btn => {
            btn.addEventListener('click', () => {
                // 保留中の条番号があればそれを使用
                if (pendingArticleNum) {
                    searchInput.value = btn.dataset.law + pendingArticleNum;
                    pendingArticleNum = null;
                } else {
                    searchInput.value = btn.dataset.law + '第1条';
                }
                doModalSearch();
            });
        });
    }
    
    // モーダルに検索結果を表示
    async function showModalResult(lawName, articleNum, modalBody) {
        modalBody.innerHTML = '<div class="loading">読み込み中...</div>';
        
        try {
            const result = await fetchArticle(lawName, articleNum);
            
            // resultが文字列の場合（parseArticleXmlからの戻り値）とオブジェクトの場合を処理
            let content = typeof result === 'string' ? result : (result.content || result);
            
            let html = `<div class="article-title">${lawName} ${articleNum}</div>`;
            html += `
                <div class="study-controls">
                    <button class="cloze-toggle" type="button">穴埋め</button>
                </div>
            `;
            html += `<div class="article-content">${content}</div>`;
            
            modalBody.innerHTML = html;

            const articleContent = modalBody.querySelector('.article-content');
            const clozeBtn = modalBody.querySelector('.cloze-toggle');
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
            modalBody.querySelectorAll('.law-ref-internal').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targetLaw = link.dataset.law;
                    const targetArticle = link.dataset.article;
                    if (targetLaw && targetArticle) {
                        const input = searchModal.querySelector('.search-input');
                        input.value = targetLaw + targetArticle;
                        showModalResult(targetLaw, targetArticle, modalBody);
                    }
                });
            });
            
        } catch (error) {
            modalBody.innerHTML = `<div class="error">${error.message}</div>`;
        }
    }
    
    // 検索モーダルを開く
    function openSearchModal(initialQuery = '') {
        if (!searchModal) createSearchModal();
        
        const modalContent = searchModal.querySelector('.modal-content');
        const searchInput = searchModal.querySelector('.search-input');
        
        // 位置を中央にリセット
        modalContent.style.left = '50%';
        modalContent.style.top = '80px';
        modalContent.style.transform = 'translateX(-50%)';
        
        searchInput.value = initialQuery;
        searchModal.classList.add('active');
        
        // フローティングボタンを非表示
        const floatingBtn = document.getElementById('jyobun-floating-btn');
        if (floatingBtn) floatingBtn.style.setProperty('display', 'none', 'important');
        
        // フォーカスを検索ボックスに
        setTimeout(() => searchInput.focus(), 100);
        
        // 初期クエリがあれば自動検索
        if (initialQuery) {
            searchInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
        }
    }

    // フローティングボタンを作成
    function createFloatingButton() {
        // 既に存在する場合はスキップ
        if (document.getElementById('jyobun-floating-btn')) return;
        
        const btn = document.createElement('button');
        btn.id = 'jyobun-floating-btn';
        btn.innerHTML = '📚 条文スタディ検索';
        btn.setAttribute('title', 'ドラッグで移動、クリックで検索');
        
        // 保存された位置を取得、またはデフォルト位置
        chrome.storage.sync.get({ floatingBtnPos: { top: 20, right: 20 } }, (settings) => {
            const pos = settings.floatingBtnPos;
            btn.style.cssText = `
                all: initial !important;
                position: fixed !important;
                top: ${pos.top}px !important;
                right: ${pos.right}px !important;
                z-index: 2147483647 !important;
                display: block !important;
                padding: 10px 16px !important;
                background: linear-gradient(135deg, #1a237e, #3949ab) !important;
                border: none !important;
                border-radius: 25px !important;
                box-shadow: 0 4px 12px rgba(26, 35, 126, 0.4) !important;
                cursor: grab !important;
                font-size: 14px !important;
                font-family: 'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif !important;
                color: white !important;
                font-weight: bold !important;
                user-select: none !important;
                white-space: nowrap !important;
            `;
        });
        
        // ドラッグ機能
        let isDragging = false;
        let hasMoved = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let btnStartRight = 0;
        let btnStartTop = 0;
        
        btn.addEventListener('mousedown', (e) => {
            isDragging = true;
            hasMoved = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            btnStartRight = window.innerWidth - btn.getBoundingClientRect().right;
            btnStartTop = btn.getBoundingClientRect().top;
            btn.style.cursor = 'grabbing';
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                hasMoved = true;
            }
            
            const newRight = Math.max(0, btnStartRight - dx);
            const newTop = Math.max(0, btnStartTop + dy);
            
            btn.style.setProperty('right', newRight + 'px', 'important');
            btn.style.setProperty('top', newTop + 'px', 'important');
        });
        
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                btn.style.cursor = 'grab';
                
                // 位置を保存
                if (hasMoved) {
                    const rect = btn.getBoundingClientRect();
                    const pos = {
                        top: rect.top,
                        right: window.innerWidth - rect.right
                    };
                    chrome.storage.sync.set({ floatingBtnPos: pos });
                }
            }
        });
        
        // クリックで検索モーダルを開く（ドラッグ中でなければ）
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // ドラッグ後はクリック扱いにしない
            if (hasMoved) {
                hasMoved = false;
                return;
            }
            
            const selectedText = window.getSelection().toString().trim();
            openSearchModal(selectedText);
        });
        
        document.body.appendChild(btn);
    }

    // バックグラウンドからのメッセージを受信（コンテキストメニュー用）
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'showArticleFromSelection') {
            const text = message.text;
            const parsed = parseLawReferenceFromText(text);
            if (parsed) {
                // 検索モーダルを開いて条文を表示
                openSearchModal(parsed.lawName + parsed.articleNum);
            }
        }
        
        // フローティングボタンの表示/非表示切り替え
        if (message.action === 'toggleFloatingBtn') {
            const btn = document.getElementById('jyobun-floating-btn');
            if (message.visible) {
                if (!btn) {
                    createFloatingButton();
                } else {
                    btn.style.setProperty('display', 'block', 'important');
                }
            } else {
                if (btn) {
                    btn.style.setProperty('display', 'none', 'important');
                }
            }
        }
    });

    // テキストから法令参照をパース
    function parseLawReferenceFromText(text) {
        text = text.replace(/\s+/g, '').replace(/条の([一二三四五六七八九十0-9０-９]+)条/g, '条の$1');
        const LAW_NAMES_STR = Object.keys(LAW_IDS).join('|');
        const LAW_ABBREVS_STR = Object.keys(LAW_ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|');
        const pattern = new RegExp(
            `(${LAW_NAMES_STR}|${LAW_ABBREVS_STR})(第?[一二三四五六七八九十百千0-9０-９]+条(?:の[一二三四五六七八九十0-9０-９]+)?(?:第?[一二三四五六七八九十0-9０-９]+項)?(?:第?[一二三四五六七八九十0-9０-９]+号)?)`
        );
        
        const match = text.match(pattern);
        if (match) {
            let lawName = match[1];
            const articleNum = match[2];
            
            // 略称を正式名称に変換
            if (LAW_ABBREVIATIONS[lawName]) {
                lawName = LAW_ABBREVIATIONS[lawName];
            }
            
            return { lawName, articleNum };
        }
        return null;
    }

    init();
})();
