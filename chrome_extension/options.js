'use strict';

// デフォルト設定
const DEFAULT_SETTINGS = {
    enabled: true,
    excludedSites: ''
};

// DOM要素
const enabledCheckbox = document.getElementById('enabled');
const excludedSitesTextarea = document.getElementById('excludedSites');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');

// 設定を読み込み
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        enabledCheckbox.checked = result.enabled;
        excludedSitesTextarea.value = result.excludedSites;
    } catch (error) {
        console.error('設定の読み込みに失敗しました:', error);
    }
}

// 設定を保存
async function saveSettings() {
    try {
        const settings = {
            enabled: enabledCheckbox.checked,
            excludedSites: excludedSitesTextarea.value.trim()
        };
        
        await chrome.storage.sync.set(settings);
        
        // 保存完了を表示
        saveStatus.classList.add('visible');
        setTimeout(() => {
            saveStatus.classList.remove('visible');
        }, 2000);
    } catch (error) {
        console.error('設定の保存に失敗しました:', error);
        alert('設定の保存に失敗しました');
    }
}

// イベントリスナー
saveBtn.addEventListener('click', saveSettings);

// 初期化
loadSettings();
