'use strict';
const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  // 显示/隐藏 API Key
  $('eye').addEventListener('click', () => {
    const input = $('apiKey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('eye').textContent = hidden ? '隐藏' : '显示';
    input.focus();
  });

  // 页脚/提示中的外链：经主进程用系统浏览器打开（仅放行 https）
  document.querySelectorAll('[data-open]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.dsh) window.dsh.welcomeOpenExternal(a.dataset.open);
    });
  });

  // 静态预览（file:// 直接打开、无 preload）时到此为止
  if (!window.dsh) return;

  const info = await window.dsh.welcomeInit();
  $('workspace').value = info.workspace;
  $('envPath').textContent = info.envPath;
  $('apiKey').focus();

  $('browse').addEventListener('click', async () => {
    const dir = await window.dsh.welcomeBrowse();
    if (dir) $('workspace').value = dir;
  });

  const submit = async (skipKey) => {
    const apiKey = $('apiKey').value.trim();
    const workspace = $('workspace').value.trim();
    $('err').textContent = '';
    if (!skipKey && !apiKey) { $('err').textContent = '请填写 API Key，或点击下方"先跳过"。'; return; }
    if (!workspace) { $('err').textContent = '请选择工作区目录。'; return; }
    $('start').disabled = true;
    $('start').textContent = '正在保存配置…';
    const r = await window.dsh.welcomeSubmit({ apiKey, workspace, skipKey });
    if (!r.ok) {
      $('err').textContent = r.error || '保存失败，请重试。';
      $('start').disabled = false;
      $('start').textContent = '启动 DSH Desktop';
      return;
    }
    window.close();
  };

  $('start').addEventListener('click', () => submit(false));
  $('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(false); });
  $('skip').addEventListener('click', () => submit(true));
});
