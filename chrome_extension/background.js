// 条文スタディ - Background Service Worker
'use strict';

// コンテキストメニューを作成
chrome.runtime.onInstalled.addListener(() => {
    // テキスト選択時のメニュー
    chrome.contextMenus.create({
        id: 'jyobun-search-selection',
        title: '「%s」を条文スタディで検索',
        contexts: ['selection']
    });
    
    // 通常の右クリックメニュー（選択なし）
    chrome.contextMenus.create({
        id: 'jyobun-open',
        title: '条文スタディを開く',
        contexts: ['page', 'frame']
    });
});

// コンテキストメニュークリック時の処理
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'jyobun-search-selection' && info.selectionText) {
        const selectedText = info.selectionText.trim();
        
        // 検索ページを開く
        chrome.tabs.create({
            url: chrome.runtime.getURL(`search.html?q=${encodeURIComponent(selectedText)}`)
        });
    } else if (info.menuItemId === 'jyobun-open') {
        // 検索ページを開く（空の状態）
        chrome.tabs.create({
            url: chrome.runtime.getURL('search.html')
        });
    }
});

// content scriptからのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'openSearch') {
        const query = message.query || '';
        const url = query 
            ? chrome.runtime.getURL(`search.html?q=${encodeURIComponent(query)}`)
            : chrome.runtime.getURL('search.html');
        
        chrome.tabs.create({ url });
    }
});
