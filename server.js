<!doctype html>
<html lang="pt-BR">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-17964942771"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','AW-17964942771');</script>
<meta charset="utf-8"/>
<link rel="icon" type="image/x-icon" href="favicon.ico"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ConsultaJá24h · Consulta Médica Online</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;min-height:100vh}
body{font-family:'Outfit',sans-serif;background:#060d0b;color:rgba(255,255,255,.92);-webkit-font-smoothing:antialiased;overflow-x:hidden}
:root{--g1:#b4e05a;--g2:#5ee0a0;--line:rgba(255,255,255,.09);--muted:rgba(255,255,255,.55)}
.bg-glow{position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(ellipse 70vw 60vh at 10% 0%,rgba(180,224,90,.12) 0%,transparent 60%),radial-gradient(ellipse 50vw 40vh at 90% 10%,rgba(94,224,160,.09) 0%,transparent 55%)}
.nav{position:sticky;top:0;z-index:100;background:rgba(6,13,11,.85);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.nav__in{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;gap:12px}
.nav__brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:.88rem;text-decoration:none}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--g2);animation:pulse 2s ease-in-out infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(94,224,160,.5)}50%{opacity:.8;box-shadow:0 0 0 5px rgba(94,224,160,0)}}
.nav__step{font-size:.72rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.screen{display:none;min-height:calc(100vh - 52px);position:relative;z-index:1}
.screen.active{display:flex;flex-direction:column}
.box-center{align-items:center;justify-content:center;padding:20px}
.box{border:1px solid var(--line);border-radius:22px;background:rgba(255,255,255,.03);overflow:hidden}
.box-head{padding:22px 24px 18px;border-bottom:1px solid var(--line)}
.box-head h1{font-family:'Playfair Display',serif;font-size:1.35rem;font-weight:500;margin-bottom:5px}
.box-head p{font-size:.78rem;color:var(--muted);font-weight:300}
#screen-identify .box{width:min(480px,100%)}
.identify-body{padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.id-label{font-size:.75rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:4px}
.id-input{width:100%;padding:12px 14px;border-radius:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);font-family:'Outfit',sans-serif;font-size:.9rem;font-weight:300;color:#fff;outline:none;transition:border-color .2s;-webkit-appearance:none}
.id-input::placeholder{color:rgba(255,255,255,.25)}
.id-input:focus{border-color:rgba(94,224,160,.35)}
.id-note{font-size:.72rem;color:rgba(255,255,255,.28);font-weight:300;line-height:1.6;padding:10px 14px;background:rgba(255,255,255,.02);border-radius:10px;border:1px solid rgba(255,255,255,.06)}
.check-same-row{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.83rem;color:rgba(255,255,255,.6)}
.check-same-row input{width:16px;height:16px;accent-color:#b4e05a;cursor:pointer;flex-shrink:0}
.id-btn{width:100%;padding:14px;border-radius:13px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:'Outfit',sans-serif;font-weight:700;font-size:.95rem;cursor:pointer;-webkit-appearance:none;box-shadow:0 6px 24px rgba(180,224,90,.25);transition:transform .12s,box-shadow .2s}
.id-btn:hover{transform:translateY(-1px)}
#screen-terms .box{width:min(580px,100%)}
.terms-body{padding:20px 24px;display:flex;flex-direction:column;gap:10px}
.titem{font-size:.82rem;font-weight:300;color:rgba(255,255,255,.6);line-height:1.7;padding-left:12px;border-left:2px solid rgba(180,224,90,.3)}
.titem strong{color:rgba(255,255,255,.85);font-weight:500;display:block;margin-bottom:2px}
.terms-foot{padding:20px 24px 26px;border-top:1px solid var(--line);background:rgba(0,0,0,.25)}
.check-row{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;cursor:pointer}
.check-row input{width:22px;height:22px;margin-top:1px;accent-color:#b4e05a;flex-shrink:0;cursor:pointer}
.check-row span{font-size:.84rem;color:rgba(255,255,255,.82);line-height:1.55}
.btn-aceitar{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:'Outfit',sans-serif;font-weight:700;font-size:1rem;cursor:not-allowed;opacity:.3;display:block;-webkit-appearance:none;transition:opacity .25s,transform .12s}
.btn-aceitar.on{opacity:1;cursor:pointer}
.btn-aceitar.on:hover{transform:translateY(-1px)}
#screen-modalidade .modal-wrap{width:min(520px,100%);padding:24px 20px}
.modal-head{text-align:center;margin-bottom:28px}
.modal-head h1{font-family:'Playfair Display',serif;font-size:1.45rem;font-weight:500;margin-bottom:8px}
.modal-head p{font-size:.85rem;color:var(--muted);font-weight:300;line-height:1.6}
.modal-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:480px){.modal-cards{grid-template-columns:1fr}}
.modal-card{border:2px solid var(--line);border-radius:20px;background:rgba(255,255,255,.03);padding:26px 20px;cursor:pointer;transition:all .2s;text-align:center;position:relative}
.modal-card:hover{border-color:rgba(94,224,160,.3);transform:translateY(-2px)}
.modal-card.selected.chat{border-color:rgba(37,211,102,.5);background:rgba(37,211,102,.06)}
.modal-card.selected.video{border-color:rgba(94,224,160,.5);background:rgba(94,224,160,.06)}
.mc-icon{font-size:2rem;margin-bottom:12px;display:block}
.mc-title{font-size:1rem;font-weight:600;margin-bottom:6px}
.mc-desc{font-size:.78rem;color:var(--muted);font-weight:300;line-height:1.5}
.mc-badge{display:inline-block;margin-top:10px;font-size:.68rem;font-weight:600;padding:3px 10px;border-radius:999px;letter-spacing:.06em;text-transform:uppercase}
.modal-card.chat .mc-badge{background:rgba(37,211,102,.12);color:#25d366}
.modal-card.video .mc-badge{background:rgba(94,224,160,.12);color:var(--g2)}
.mc-check{display:none;position:absolute;top:12px;right:12px;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#b4e05a,#5ee0a0);align-items:center;justify-content:center}
.modal-card.selected .mc-check{display:flex}
.mc-check svg{width:12px;height:12px;color:#051208}
.btn-modal-cont{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:'Outfit',sans-serif;font-weight:700;font-size:1rem;cursor:not-allowed;opacity:.3;margin-top:18px;transition:opacity .25s,transform .12s;-webkit-appearance:none}
.btn-modal-cont.on{opacity:1;cursor:pointer}
.btn-modal-cont.on:hover{transform:translateY(-1px)}
#screen-disponibilidade .dispon-wrap{width:min(520px,100%);padding:24px 20px;text-align:center}
.dispon-wrap h1{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:500;margin-bottom:8px}
.dispon-wrap p{font-size:.85rem;color:var(--muted);font-weight:300;line-height:1.6;margin-bottom:24px}
.dispon-status{display:inline-flex;align-items:center;gap:10px;padding:14px 24px;border-radius:14px;font-size:.9rem;font-weight:600;margin-bottom:24px}
.dispon-status.verde{background:rgba(94,224,160,.1);border:1px solid rgba(94,224,160,.25);color:var(--g2)}
.dispon-status.amarelo{background:rgba(255,189,46,.1);border:1px solid rgba(255,189,46,.25);color:#ffbd2e}
.dispon-status.vermelho{background:rgba(255,95,87,.1);border:1px solid rgba(255,95,87,.25);color:#ff8080}
.dispon-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.verde .dispon-dot{background:var(--g2);animation:pulse 2s infinite}
.amarelo .dispon-dot{background:#ffbd2e}
.vermelho .dispon-dot{background:#ff8080}
.dispon-info{font-size:.8rem;color:rgba(255,255,255,.4);margin-bottom:20px;font-weight:300}
.btn-dispon-cont{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:'Outfit',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;-webkit-appearance:none;box-shadow:0 6px 24px rgba(180,224,90,.28);transition:transform .12s}
.btn-dispon-cont:hover{transform:translateY(-1px)}
.horarios-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.horario-btn{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:rgba(255,255,255,.7);font-family:'Outfit',sans-serif;font-size:.82rem;font-weight:500;cursor:pointer;transition:all .18s;-webkit-appearance:none}
.horario-btn:hover{border-color:rgba(66,133,244,.4);background:rgba(66,133,244,.08);color:#fff}
.horario-btn.selected{border-color:rgba(66,133,244,.6);background:rgba(66,133,244,.15);color:#fff;font-weight:600}
.btn-agendar{width:100%;padding:14px;border-radius:13px;border:none;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:.95rem;cursor:not-allowed;opacity:.3;-webkit-appearance:none;transition:opacity .2s,transform .12s;margin-top:4px}
.btn-agendar.on{opacity:1;cursor:pointer}
.btn-agendar.on:hover{transform:translateY(-1px)}
.agend-note{font-size:.72rem;color:rgba(255,255,255,.28);font-weight:300;line-height:1.6;padding:10px 14px;background:rgba(66,133,244,.04);border-radius:10px;border:1px solid rgba(66,133,244,.1);margin-bottom:16px;text-align:left}
/* ── PAGAMENTO ── */
#screen-payment .box{width:min(500px,100%)}
.pay-head{padding:22px 24px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}
.pay-icon{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,rgba(180,224,90,.18),rgba(94,224,160,.12));border:1px solid rgba(180,224,90,.25);display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0}
.pay-head-text h2{font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:500;margin-bottom:3px}
.pay-head-text p{font-size:.76rem;color:var(--muted);font-weight:300}
.pay-body{padding:22px 24px}
.pay-valor{display:flex;align-items:center;justify-content:space-between;background:rgba(180,224,90,.06);border:1px solid rgba(180,224,90,.15);border-radius:16px;padding:16px 20px;margin-bottom:20px}
.pay-valor-left .label{font-size:.68rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:4px}
.pay-valor-left .desc{font-size:.78rem;color:rgba(255,255,255,.5);font-weight:300;margin-top:3px}
.pay-price{font-family:'Playfair Display',serif;font-size:2rem;font-weight:700;color:#b4e05a;line-height:1}
.pay-label{font-size:.72rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.38);margin-bottom:8px}
.pay-input{width:100%;padding:12px 16px;border-radius:13px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:#fff;font-family:'Outfit',sans-serif;font-size:.875rem;font-weight:300;outline:none;transition:border-color .2s;-webkit-appearance:none;margin-bottom:14px}
.pay-input::placeholder{color:rgba(255,255,255,.25)}
.pay-input:focus{border-color:rgba(94,224,160,.35)}
.pay-btn{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:'Outfit',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;-webkit-appearance:none;box-shadow:0 6px 24px rgba(180,224,90,.28);transition:opacity .2s,transform .12s}
.pay-btn:hover{transform:translateY(-1px)}
.pay-btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.pay-copy-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;border:1px solid rgba(180,224,90,.3);background:rgba(180,224,90,.07);color:#b4e05a;font-family:'Outfit',sans-serif;font-size:.82rem;font-weight:500;cursor:pointer;-webkit-appearance:none;transition:background .15s;margin-bottom:12px}
.pay-copy-btn:hover{background:rgba(180,224,90,.14)}
.pay-divider{display:flex;align-items:center;gap:10px;margin:18px 0 0;font-size:.7rem;color:rgba(255,255,255,.2)}
.pay-divider::before,.pay-divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.07)}
.pay-seguro{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;font-size:.72rem;color:rgba(255,255,255,.3);font-weight:300}
/* ── QR dinâmico ── */
.pay-qr-section{display:none;text-align:center;margin-top:20px}
.pay-qr-section.ativo{display:block}
.pay-qr-img{width:220px;height:220px;border-radius:16px;border:2px solid rgba(180,224,90,.25);background:#fff;padding:10px;display:block;margin:0 auto 14px;image-rendering:pixelated}
.pay-polling-status{margin-top:14px;font-size:.78rem;color:rgba(255,255,255,.35);font-weight:300;line-height:1.6}
.pay-polling-status.ok{color:#5ee0a0}
.pay-polling-status.err{color:#ff8080}
/* ── TRIAGEM ── */
#screen-triage{flex-direction:column}
.progress-bar{height:3px;background:rgba(255,255,255,.06);flex-shrink:0}
.progress-fill{height:100%;background:linear-gradient(90deg,#b4e05a,#5ee0a0);transition:width .5s ease;width:0%}
.ia-banner{background:rgba(255,189,46,.06);border:1px solid rgba(255,189,46,.18);border-radius:0;padding:10px 20px;display:flex;align-items:center;gap:10px;font-size:.78rem;color:rgba(255,189,46,.9);font-weight:400;flex-shrink:0}
.ia-banner strong{font-weight:600}
.chat-area{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
.chat-area::-webkit-scrollbar{width:3px}
.chat-area::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
.msg{display:flex;gap:10px;align-items:flex-end;animation:fadeUp .25s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.msg--bot{align-self:flex-start;max-width:85%}
.msg--user{align-self:flex-end;flex-direction:row-reverse;max-width:85%}
.msg__av{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.06);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:.8rem;flex-shrink:0}
.msg__bubble{padding:11px 15px;border-radius:16px;font-size:.875rem;font-weight:300;line-height:1.65}
.msg--bot .msg__bubble{background:rgba(255,255,255,.06);border:1px solid var(--line);border-bottom-left-radius:4px;color:rgba(255,255,255,.88)}
.msg--user .msg__bubble{background:linear-gradient(135deg,#b4e05a,#6ed49a);color:#051208;font-weight:500;border-bottom-right-radius:4px}
.typing{display:flex;gap:4px;padding:11px 15px;align-items:center}
.typing span{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.4);animation:typDot 1.2s ease-in-out infinite}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}
@keyframes typDot{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-5px);opacity:1}}
.quick-replies{display:flex;flex-wrap:wrap;gap:8px;padding:0 20px 12px}
.qr{padding:8px 16px;border-radius:999px;border:1px solid rgba(180,224,90,.3);background:rgba(180,224,90,.06);color:var(--g1);font-family:'Outfit',sans-serif;font-size:.8rem;font-weight:500;cursor:pointer;transition:background .15s;-webkit-appearance:none}
.qr:hover{background:rgba(180,224,90,.14)}
.input-bar{padding:12px 16px 20px;border-top:1px solid var(--line);background:rgba(6,13,11,.9);display:flex;gap:10px;align-items:flex-end;flex-shrink:0}
.input-bar textarea{flex:1;padding:10px 14px;border-radius:13px;background:rgba(255,255,255,.07);border:1px solid var(--line);color:#fff;font-family:'Outfit',sans-serif;font-size:.875rem;font-weight:300;resize:none;outline:none;min-height:42px;max-height:110px;line-height:1.5;transition:border-color .2s;-webkit-appearance:none}
.input-bar textarea::placeholder{color:rgba(255,255,255,.28)}
.input-bar textarea:focus{border-color:rgba(94,224,160,.35)}
.send-btn{width:42px;height:42px;border-radius:50%;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:transform .12s;box-shadow:0 4px 14px rgba(180,224,90,.28);-webkit-appearance:none}
.send-btn:hover{transform:scale(1.08)}
.send-btn[disabled]{opacity:.4;cursor:not-allowed;transform:none}
/* ── ESPERA ── */
#screen-espera .espera-box{width:min(580px,100%);text-align:center;padding:32px 20px}
.espera-anim{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,rgba(180,224,90,.15),rgba(94,224,160,.1));border:1px solid rgba(94,224,160,.25);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;position:relative;transition:background .5s}
.espera-anim::before{content:'';position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(94,224,160,.15);animation:ring 2s ease-in-out infinite}
.espera-anim::after{content:'';position:absolute;inset:-16px;border-radius:50%;border:1px solid rgba(94,224,160,.08);animation:ring 2s ease-in-out infinite .4s}
@keyframes ring{0%{transform:scale(.9);opacity:.8}100%{transform:scale(1.1);opacity:0}}
.espera-titulo{font-family:'Playfair Display',serif;font-size:1.45rem;font-weight:500;margin-bottom:10px}
.espera-sub{font-size:.88rem;font-weight:300;color:rgba(255,255,255,.5);line-height:1.7;margin-bottom:24px}
.espera-badge{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:999px;font-size:.82rem;font-weight:600;margin-bottom:24px}
.espera-badge.chat{background:rgba(37,211,102,.1);border:1px solid rgba(37,211,102,.25);color:#25d366}
.espera-badge.video{background:rgba(94,224,160,.1);border:1px solid rgba(94,224,160,.25);color:var(--g2)}
.espera-status{font-size:.78rem;color:rgba(255,255,255,.3);font-weight:300;margin-bottom:32px}
.chat-consulta{width:100%;display:none;text-align:left}
.chat-consulta.ativo{display:flex;flex-direction:column}
.medico-entrou-banner{display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(94,224,160,.07);border:1px solid rgba(94,224,160,.2);border-radius:14px;margin-bottom:14px;font-size:.85rem;color:rgba(255,255,255,.85);font-weight:500}
.medico-entrou-banner span{font-size:1.1rem}
.chat-header-box{text-align:center;margin-bottom:14px;padding:14px 20px;background:rgba(37,211,102,.06);border:1px solid rgba(37,211,102,.15);border-radius:14px}
.chat-header-box h3{font-size:.95rem;font-weight:600;margin-bottom:3px;display:flex;align-items:center;justify-content:center;gap:8px}
.chat-header-box p{font-size:.75rem;color:var(--muted);font-weight:300}
.online-dot{width:6px;height:6px;border-radius:50%;background:var(--g2);animation:pulse 2s ease-in-out infinite;flex-shrink:0}
.chat-msgs{overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:16px;min-height:250px;max-height:360px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:16px 16px 0 0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.08) transparent}
.chat-msgs::-webkit-scrollbar{width:3px}
.chat-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px}
.chat-input-row{display:flex;gap:10px;padding:12px 14px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-top:none;border-radius:0 0 16px 16px}
.chat-input-row textarea{flex:1;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:#fff;font-family:'Outfit',sans-serif;font-size:.875rem;font-weight:300;resize:none;outline:none;min-height:42px;max-height:100px;line-height:1.5;-webkit-appearance:none}
.chat-input-row textarea:focus{border-color:rgba(94,224,160,.35)}
.chat-input-row textarea::placeholder{color:rgba(255,255,255,.25)}
.chat-input-row textarea:disabled{opacity:.4;cursor:not-allowed}
.chat-send{width:42px;height:42px;border-radius:50%;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .12s;-webkit-appearance:none}
.chat-send:hover{transform:scale(1.08)}
.chat-send:disabled{opacity:.4;cursor:not-allowed;transform:none}
.cmsg{display:flex;gap:8px;align-items:flex-end;animation:fadeUp .2s ease}
.cmsg.paciente{flex-direction:row-reverse}
.cmsg .av{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.06);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:.75rem;flex-shrink:0}
.cmsg .bwrap{display:flex;flex-direction:column;max-width:78%}
.cmsg.paciente .bwrap{align-items:flex-end}
.cmsg .bub{padding:10px 14px;border-radius:14px;font-size:.85rem;font-weight:300;line-height:1.6}
.cmsg.medico .bub{background:rgba(255,255,255,.06);border:1px solid var(--line);border-bottom-left-radius:4px;color:rgba(255,255,255,.88)}
.cmsg.paciente .bub{background:linear-gradient(135deg,#b4e05a,#6ed49a);color:#051208;font-weight:500;border-bottom-right-radius:4px}
.cmsg .ts{font-size:.62rem;color:rgba(255,255,255,.2);margin-top:2px;padding:0 2px}
.meet-wrap{display:none}
.meet-wrap.ativo{display:block;text-align:center}
.meet-aguardando{padding:20px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:16px;margin-bottom:18px}
.meet-aguardando p{font-size:.85rem;color:var(--muted);font-weight:300;line-height:1.6}
.btn-meet{display:inline-flex;align-items:center;gap:10px;padding:15px 30px;border-radius:14px;border:none;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;font-family:'Outfit',sans-serif;font-size:.95rem;font-weight:600;cursor:pointer;text-decoration:none;box-shadow:0 6px 20px rgba(66,133,244,.3);transition:transform .12s,box-shadow .2s}
.btn-meet:not(.disabled):hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(66,133,244,.45)}
.btn-meet.disabled{opacity:.4;pointer-events:none}
/* ── ENCERRADO ── */
.encerrado-box{width:min(480px,100%);text-align:center;padding:32px 20px}
.encerrado-icon{font-size:3rem;margin-bottom:20px}
.encerrado-titulo{font-family:'Playfair Display',serif;font-size:1.45rem;font-weight:500;margin-bottom:10px;color:var(--g2)}
.encerrado-sub{font-size:.88rem;font-weight:300;color:rgba(255,255,255,.5);line-height:1.7;margin-bottom:28px}
.encerrado-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 26px;border-radius:13px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);font-family:'Outfit',sans-serif;font-size:.88rem;font-weight:500;cursor:pointer;-webkit-appearance:none;transition:background .2s}
.encerrado-btn:hover{background:rgba(255,255,255,.1)}
.loading-overlay{position:fixed;inset:0;z-index:999;background:#060d0b;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
.loading-overlay.hide{display:none}
.loading-spinner{width:40px;height:40px;border:3px solid rgba(255,255,255,.08);border-top-color:var(--g2);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-txt{font-size:.85rem;color:rgba(255,255,255,.4);font-weight:300}
</style>
</head>
<body>
<div class="bg-glow" aria-hidden="true"></div>
<div class="loading-overlay" id="loading-overlay"><div class="loading-spinner"></div><div class="loading-txt">Verificando sessão...</div></div>

<nav class="nav">
  <div class="nav__in">
    <a href="index.html" class="nav__brand">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="30" height="30" style="flex-shrink:0">
        <defs><radialGradient id="nb" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="#0d1f17"/><stop offset="100%" stop-color="#060d0b"/></radialGradient><linearGradient id="ng" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#b4e05a"/><stop offset="100%" stop-color="#5ee0a0"/></linearGradient><linearGradient id="nr" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#b4e05a" stop-opacity="0.4"/><stop offset="100%" stop-color="#5ee0a0" stop-opacity="0.15"/></linearGradient></defs>
        <circle cx="22" cy="22" r="21" fill="none" stroke="url(#nr)" stroke-width="0.8"/><circle cx="22" cy="22" r="19.5" fill="url(#nb)"/>
        <rect x="19.5" y="10" width="3.8" height="24" rx="1.2" fill="url(#ng)"/><rect x="10" y="19.5" width="24" height="3.8" rx="1.2" fill="url(#ng)"/>
        <rect x="22.5" y="19.5" width="11.5" height="3.8" rx="0" fill="url(#nb)"/>
        <polyline points="22.5,21.4 25,21.4 26.5,17 28,26 29.5,20 31,21.4 34,21.4" fill="none" stroke="url(#ng)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span style="font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:.92rem;font-weight:700;letter-spacing:-.01em">
        <span style="color:rgba(255,255,255,.93)">Consulta</span><span style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">Já</span><span style="font-family:'Outfit',sans-serif;font-style:normal;font-size:.68rem;font-weight:500;color:rgba(255,255,255,.38);-webkit-text-fill-color:rgba(255,255,255,.38)">24h</span>
      </span>
    </a>
    <span class="nav__step" id="nav-step">IDENTIFICAÇÃO</span>
  </div>
</nav>

<!-- S1: IDENTIFICAÇÃO -->
<div id="screen-identify" class="screen box-center">
  <div class="box">
    <div class="box-head"><h1>Bem-vindo</h1><p>Precisamos de alguns dados básicos para iniciar.</p></div>
    <div class="identify-body">
      <div><div class="id-label">Nome completo</div><input class="id-input" id="idNome" type="text" placeholder="Como você se chama?" autocomplete="name"/></div>
      <div><div class="id-label">WhatsApp (com DDD)</div><input class="id-input" id="idTel" type="tel" placeholder="Ex: 98999990000" autocomplete="tel" inputmode="numeric"/></div>
      <div>
        <div class="id-label">Data de nascimento</div>
        <input class="id-input" id="idNascimento" type="text" placeholder="DD/MM/AAAA" inputmode="numeric" maxlength="10" oninput="mascaraData(this)"/>
      </div>
      <div>
        <div class="id-label">Telefone para receber documentos (SMS) <span style="color:rgba(255,255,255,.3);font-size:.68rem;font-weight:300;text-transform:none;letter-spacing:0">opcional</span></div>
        <input class="id-input" id="idTelDoc" type="tel" placeholder="Ex: 98999990000" inputmode="numeric"/>
        <label class="check-same-row" style="margin-top:8px" for="chkSameNumber">
          <input type="checkbox" id="chkSameNumber" onchange="toggleSameNumber(this)"/>
          Usar o mesmo número do WhatsApp
        </label>
      </div>
      <div class="id-note">🔒 Seus dados são registrados com segurança conforme a LGPD.</div>
      <button class="id-btn" onclick="avancarIdentificacao()">Continuar →</button>
    </div>
  </div>
</div>

<!-- S2: TERMOS -->
<div id="screen-terms" class="screen box-center">
  <div class="box">
    <div class="box-head"><h1>Termos de Uso e TCLE</h1><p>Leia os pontos principais antes de prosseguir.</p></div>
    <div class="terms-body">
      <div class="titem"><strong>Serviço</strong>Orientação médica remota por profissional com CRM ativo, conforme Resolução CFM nº 2.314/2022. Não substitui atendimento presencial em urgências.</div>
      <div class="titem"><strong>Triagem automatizada</strong>A coleta de anamnese usa IA para estruturar as informações. Não constitui diagnóstico. Toda informação é revisada pelo médico.</div>
      <div class="titem"><strong>Transferência de dados</strong>Dados podem ser processados por provedor internacional de IA com garantias contratuais, conforme Arts. 33–36 da LGPD.</div>
      <div class="titem"><strong>Documentos</strong>Atestados e receitas são emitidos exclusivamente quando há indicação clínica. Não são automáticos.</div>
      <div class="titem"><strong>Privacidade</strong>Dados sensíveis de saúde tratados com sigilo, conforme Lei 13.709/2018 (LGPD).</div>
      <div class="titem"><strong>Emergências</strong>Em caso de dor no peito, falta de ar grave, desmaio ou risco de vida, procure pronto-socorro imediatamente.</div>
    </div>
    <div class="terms-foot">
      <label class="check-row" for="termsCheck"><input type="checkbox" id="termsCheck"/><span>Li e concordo com os <a href="termos.html" target="_blank" style="color:#b4e05a">Termos de Uso</a>, <a href="privacy.html" target="_blank" style="color:#b4e05a">Política de Privacidade</a> e TCLE, incluindo uso de IA para triagem.</span></label>
      <button class="btn-aceitar" id="btnAceitar">Aceitar e continuar</button>
    </div>
  </div>
</div>

<!-- S3: MODALIDADE -->
<div id="screen-modalidade" class="screen box-center">
  <div class="modal-wrap">
    <div class="modal-head"><h1>Como prefere ser atendido?</h1><p>Escolha a modalidade da sua consulta.</p></div>
    <div class="modal-cards">
      <div class="modal-card chat" onclick="selecionarModalidade('chat',this)">
        <div class="mc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
        <span class="mc-icon">💬</span><div class="mc-title">Consulta por chat</div>
        <div class="mc-desc">Mensagens em tempo real com o médico pela plataforma.</div>
        <span class="mc-badge">Texto</span>
      </div>
      <div class="modal-card video" onclick="selecionarModalidade('video',this)">
        <div class="mc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
        <span class="mc-icon">🎥</span><div class="mc-title">Consulta por vídeo</div>
        <div class="mc-desc">Consulta ao vivo via Google Meet.</div>
        <span class="mc-badge">Videochamada</span>
      </div>
    </div>
    <button class="btn-modal-cont" id="btnModalCont" disabled>Continuar →</button>
  </div>
</div>

<!-- S4: DISPONIBILIDADE -->
<div id="screen-disponibilidade" class="screen box-center">
  <div class="dispon-wrap">

    <!-- Atendimento imediato -->
    <div id="imediato-section">
      <h1 id="disp-titulo">Verificando disponibilidade...</h1>
      <p id="disp-sub">Aguarde um instante.</p>
      <div class="dispon-status verde" id="disp-status-badge" style="margin:0 auto 20px"><div class="dispon-dot"></div><span id="disp-status-txt">Verificando...</span></div>
      <p class="dispon-info" id="disp-info"></p>
      <button class="btn-dispon-cont" id="btnDispCont" onclick="continuar_apos_disponibilidade()" style="display:none">Atendimento imediato →</button>
    </div>

    <!-- Agendamento -->
    <div id="agend-section" style="display:none">
      <div style="display:flex;align-items:center;gap:12px;margin:28px 0 24px">
        <div style="flex:1;height:1px;background:rgba(255,255,255,.08)"></div>
        <span style="font-size:.72rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.25)">ou agende um horário</span>
        <div style="flex:1;height:1px;background:rgba(255,255,255,.08)"></div>
      </div>
      <div class="box" style="border-radius:18px;text-align:left">
        <div class="box-head">
          <h1 style="font-size:1.05rem;font-family:'Outfit',sans-serif;font-weight:600">📅 Agendar consulta</h1>
          <p style="margin-top:6px">Escolha um horário e confirme com o pagamento. A triagem é feita agora — o médico já chega preparado.</p>
          <div style="margin-top:10px;padding:10px 14px;background:rgba(255,95,87,.05);border:1px solid rgba(255,95,87,.2);border-radius:10px;font-size:.78rem;color:rgba(255,160,150,.9);line-height:1.55">
            ⚠️ <strong style="color:rgba(255,190,180,.95)">Sem reagendamento:</strong> o horário escolhido é definitivo. Em caso de desistência o valor não é reembolsado.
          </div>
        </div>
        <div style="padding:18px 22px 22px">
          <div style="font-size:.72rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:12px">Horários disponíveis</div>
          <div class="horarios-grid" id="horarios-grid"></div>
          <button class="btn-agendar" id="btnAgendar" disabled onclick="prosseguirAgendamento()">Confirmar horário →</button>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- S5: PAGAMENTO -->
<div id="screen-payment" class="screen box-center">
  <div class="box">
    <div class="pay-head">
      <div class="pay-icon">💳</div>
      <div class="pay-head-text"><h2>Pagamento seguro</h2><p id="pay-subtitulo">Pix instantâneo</p></div>
    </div>
    <div class="pay-body">
      <div class="pay-valor">
        <div class="pay-valor-left"><div class="label" id="pay-label-tipo">Consulta médica online</div><div class="desc">Receitas e atestados quando indicados</div></div>
        <div class="pay-price">R$&nbsp;49,90</div>
      </div>

      <div class="pay-label">Seu nome</div>
      <input class="pay-input" id="payNome" type="text" placeholder="Nome completo" autocomplete="name"/>
      <div class="pay-label">Seu WhatsApp</div>
      <input class="pay-input" id="payTel" type="tel" placeholder="DDD + número" autocomplete="tel" inputmode="numeric"/>
      <div class="pay-label">CPF</div>
      <input class="pay-input" id="payCPF" type="text" placeholder="000.000.000-00" inputmode="numeric" maxlength="14"/>
      <div style="font-size:.72rem;color:rgba(255,255,255,.35);margin-top:-8px;margin-bottom:20px;line-height:1.5">Utilizado para emissão de documentos médicos quando necessário.</div>

      <!-- Botão mostrar QR -->
      <button class="pay-btn" id="payBtn" onclick="gerarPagamento()">Ver QR Code Pix →</button>

      <!-- QR fixo do Inter — aparece após clique -->
      <div class="pay-qr-section" id="pay-qr-section">
        <div style="font-size:.72rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.38);margin-bottom:12px">Clique para ver e colar a Chave PIX</div>
        <img id="pay-qr-img" class="pay-qr-img" src="" alt="QR Code Pix"/>
        <br/>
        <!-- Campo Pix copia e cola -->
        <div style="margin-bottom:14px;width:100%">
          <div style="font-size:.68rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Chave PIX</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input id="pixChaveInput" readonly type="text" value=""
              style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(180,224,90,.2);border-radius:10px;padding:10px 12px;color:#fff;font-family:'Outfit',sans-serif;font-size:.8rem;outline:none;-webkit-user-select:all;user-select:all;cursor:pointer"
              onclick="this.select();copiarPix()"/>
            <button class="pay-copy-btn" id="payCopyBtn" onclick="copiarPix()" style="margin-bottom:0;white-space:nowrap;flex-shrink:0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copiar
            </button>
          </div>
        </div>
        <div style="font-size:.72rem;color:rgba(255,255,255,.3);margin-top:4px;line-height:1.6">JG FONSECA SERVICOS MEDICOS LTDA · R$ 49,90</div>
        <div class="pay-polling-status" id="pay-polling-status">⏳ Realize o pagamento e clique no botão abaixo</div>
        <!-- Botão de confirmação manual -->
        <button class="pay-btn" id="payConfirmBtn" onclick="confirmarPagamentoManual()" style="margin-top:18px;background:linear-gradient(135deg,#5ee0a0,#b4e05a)">
          ✅ Já realizei o pagamento
        </button>
        <div style="font-size:.7rem;color:rgba(255,255,255,.25);margin-top:10px;line-height:1.5;text-align:center">
          Após clicar, você será direcionado à triagem.<br>Pagamentos são verificados manualmente.
        </div>
      </div>

      <div class="pay-divider">pagamento via</div>
      <div class="pay-seguro">🔒 PIX · Banco Inter PJ · Dados criptografados</div>
    </div>
  </div>
</div>

<!-- S6: TRIAGEM -->
<div id="screen-triage" class="screen">
  <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
  <div class="ia-banner">
    <span style="font-size:1.1rem">🤖</span>
    <span><strong>Assistente de Triagem Automática</strong> — Você ainda não está falando com um médico. Estas perguntas preparam seu atendimento.</span>
  </div>
  <div class="chat-area" id="triageChat"></div>
  <div class="quick-replies" id="quickReplies"></div>
  <div class="input-bar">
    <textarea id="triageInput" placeholder="Digite sua resposta..." rows="1"></textarea>
    <button class="send-btn" id="triageSend" aria-label="Enviar">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>

<!-- S7: ESPERA / CONSULTA -->
<div id="screen-espera" class="screen box-center">
  <div class="espera-box">
    <div class="espera-anim" id="esperaAnim"><span style="font-size:2rem" id="esperaIcon">⏳</span></div>
    <h2 class="espera-titulo" id="esperaTitulo">Preparando seu atendimento</h2>
    <p class="espera-sub" id="esperaSub">Um médico assumirá sua consulta em breve.<br>Por favor, aguarde nesta página.</p>
    <div class="espera-badge" id="esperaBadge"><span id="esperaBadgeIcon">💬</span> <span id="esperaBadgeText">Consulta por chat</span></div>
    <p class="espera-status" id="esperaStatusTxt">Verificando... <span id="esperaContador"></span></p>
    <div style="margin-bottom:16px">
      <button onclick="novaConsulta()" style="background:none;border:none;color:rgba(255,255,255,.25);font-family:'Outfit',sans-serif;font-size:.72rem;cursor:pointer;text-decoration:underline;padding:4px 8px">
        Iniciar nova consulta
      </button>
    </div>
    <div class="chat-consulta" id="chatConsulta">
      <div class="medico-entrou-banner" id="medicoEntrou" style="display:none">
        <span>👨‍⚕️</span>
        <div><strong id="medicoNomeBanner">Dr. Médico</strong> entrou na consulta.<br><span style="font-size:.78rem;font-weight:300;color:rgba(255,255,255,.5)">Agora você está falando com um médico.</span></div>
      </div>
      <div class="chat-header-box">
        <h3><div class="online-dot"></div> Consulta iniciada</h3>
        <p id="chatMedicoLabel">Médico disponível — pode enviar sua mensagem</p>
      </div>
      <div class="chat-msgs" id="chatMsgs"></div>
      <div class="chat-input-row">
        <textarea id="chatInputPaciente" placeholder="Digite sua mensagem..." rows="1"></textarea>
        <button class="chat-send" id="chatSendBtn" onclick="enviarMensagemChat()">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
    <div class="meet-wrap" id="meetWrap">
      <div class="medico-entrou-banner" id="medicoEntrouVideo" style="display:none">
        <span>👨‍⚕️</span>
        <div><strong id="medicoNomeBannerVideo">Dr. Médico</strong> está pronto para a videochamada.<br><span style="font-size:.78rem;font-weight:300;color:rgba(255,255,255,.5)">Agora você está falando com um médico.</span></div>
      </div>
      <div class="meet-aguardando" id="meetAguardando"><p>⏳ O médico está se preparando.<br>O link da videochamada aparecerá aqui em instantes.</p></div>
      <a href="#" id="btnMeetLink" class="btn-meet disabled" target="_blank" rel="noopener">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        Entrar na videochamada
      </a>
      <p style="margin-top:10px;font-size:.72rem;color:rgba(255,255,255,.25)">Link gerado pelo médico via Google Meet</p>
    </div>
  </div>
</div>

<!-- S8: ENCERRADO -->
<div id="screen-encerrado" class="screen box-center">
  <div class="encerrado-box">
    <div class="encerrado-icon">✅</div>
    <h2 class="encerrado-titulo">Consulta encerrada</h2>
    <p class="encerrado-sub">Seu atendimento foi finalizado pelo médico.<br>Esperamos que tenha sido uma boa experiência.</p>
    <button class="encerrado-btn" onclick="novaConsulta()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      Iniciar nova consulta
    </button>
  </div>
</div>

<script>
var API = 'https://triagem-api.onrender.com';
var pacienteNome = '', pacienteTel = '', pacienteTelDoc = '', pacienteCPF = '', pacienteNascimento = '', tipoConsulta = '';
var atendimentoId = null, agendamentoId = null, horarioAgendado = null, modoAgendamento = false;
var paymentId = null, pixCode = '', paymentPoller = null;
var esperaPoller = null, chatPoller = null, meetPoller = null, encerradoPoller = null;
var ultimaMsgId = 0, chatAtivo = false, tentativas = 0;
var dispData = null;

function salvarSessao(){
  if(!atendimentoId) return;
  localStorage.setItem('cj_sessao', JSON.stringify({atendimentoId, tipoConsulta, pacienteNome, pacienteTel, pacienteCPF, ts: Date.now()}));
}
function limparSessao(){ localStorage.removeItem('cj_sessao'); }
function carregarSessao(){
  try {
    var s = localStorage.getItem('cj_sessao'); if(!s) return null;
    var obj = JSON.parse(s);
    if(Date.now() - (obj.ts||0) > 8*60*60*1000){ limparSessao(); return null; }
    return obj;
  } catch(e){ return null; }
}

(async function init(){
  var urlId = new URLSearchParams(location.search).get('consulta');
  var sessao = carregarSessao();
  var idParaRestaurar = urlId ? parseInt(urlId) : (sessao ? sessao.atendimentoId : null);
  if(idParaRestaurar){
    try{
      var res = await fetch(API+'/api/atendimento/status/'+idParaRestaurar);
      var data = await res.json();
      if(data.ok && data.atendimento){
        var a = data.atendimento;
        // Se status for triagem (pré-registro abandonado/pagamento não concluído),
        // limpa sessão e deixa o paciente recomeçar do zero
        if(a.status === 'triagem' || a.status === 'expirado' || a.status === 'arquivado'){
          limparSessao(); esconderLoading(); showScreen('identify'); return;
        }
        atendimentoId = a.id; tipoConsulta = a.tipo || 'chat';
        pacienteNome = a.nome || ''; pacienteTel = a.tel || ''; pacienteCPF = a.cpf || '';
        salvarSessao(); esconderLoading();
        if(a.status === 'encerrado'){ mostrarTelaEncerrado(); }
        else if(a.status === 'assumido'){ mostrarSalaEspera(); clearInterval(esperaPoller); medicoAssumiu(a); }
        else { mostrarSalaEspera(); }
        return;
      }
    } catch(e){}
  }
  limparSessao(); esconderLoading(); showScreen('identify');
})();

function esconderLoading(){ document.getElementById('loading-overlay').classList.add('hide'); }

function showScreen(n){
  document.querySelectorAll('.screen').forEach(function(s){s.classList.remove('active');});
  var el = document.getElementById('screen-'+n);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}

function toggleSameNumber(chk){
  var docInput = document.getElementById('idTelDoc');
  var telInput = document.getElementById('idTel');
  if(chk.checked){ docInput.value = telInput.value; docInput.disabled = true; docInput.style.opacity = '.4'; }
  else { docInput.disabled = false; docInput.style.opacity = '1'; }
}

function avancarIdentificacao(){
  var nome = document.getElementById('idNome').value.trim();
  var tel  = document.getElementById('idTel').value.replace(/\D/g,'');
  var nascimento = document.getElementById('idNascimento').value;
  var chkSame = document.getElementById('chkSameNumber').checked;
  var telDoc  = chkSame ? tel : document.getElementById('idTelDoc').value.replace(/\D/g,'');
  if(!nome){document.getElementById('idNome').focus();return;}
  if(!tel||tel.length<10){document.getElementById('idTel').focus();return;}
  pacienteNome=nome; pacienteTel=tel; pacienteTelDoc=telDoc||tel; pacienteNascimento=nascimento||'';
  fetch(API+'/api/identify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome,tel})}).catch(function(){});
  document.getElementById('payNome').value=nome;
  document.getElementById('payTel').value=tel;
  showScreen('terms');
  document.getElementById('nav-step').textContent='TERMOS DE USO';
}

(function(){
  var chk=document.getElementById('termsCheck');
  var btn=document.getElementById('btnAceitar');
  chk.addEventListener('change',function(){btn.classList.toggle('on',chk.checked);});
  btn.addEventListener('click',function(){
    if(!chk.checked)return;
    fetch(API+'/api/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:pacienteNome,tel:pacienteTel,versao:'termos-v1.0'})}).catch(function(){});
    showScreen('modalidade');
    document.getElementById('nav-step').textContent='MODALIDADE';
  });
})();

function selecionarModalidade(tipo,el){
  document.querySelectorAll('.modal-card').forEach(function(c){c.classList.remove('selected');});
  el.classList.add('selected'); tipoConsulta=tipo;
  var btn=document.getElementById('btnModalCont');
  btn.disabled=false; btn.classList.add('on');
  btn.textContent=tipo==='chat'?'💬 Continuar com chat →':'🎥 Continuar com vídeo →';
}
document.getElementById('btnModalCont').addEventListener('click',function(){ if(!tipoConsulta)return; verificarDisponibilidade(); });

async function verificarDisponibilidade(){
  showScreen('disponibilidade');
  document.getElementById('nav-step').textContent='DISPONIBILIDADE';
  document.getElementById('disp-titulo').textContent='Verificando disponibilidade...';
  document.getElementById('disp-sub').textContent='Aguarde um instante.';
  document.getElementById('btnDispCont').style.display='none';
  document.getElementById('agend-section').style.display='none';
  try{ var res = await fetch(API+'/api/disponibilidade'); dispData = await res.json(); }
  catch(e){ dispData = {ok:true,disponivel:true,status:'verde',mensagem:'Atendimento disponível',tempoEstimado:5,medicosOnline:0,horariosAgendamento:[]}; }
  renderDisponibilidade(dispData);
}

function renderDisponibilidade(d){
  document.getElementById('disp-titulo').textContent = d.disponivel ? 'Atendimento disponível' : 'Sem disponibilidade agora';
  document.getElementById('disp-sub').textContent='';
  document.getElementById('disp-info').textContent = d.disponivel
    ? (d.medicosOnline > 0 ? d.medicosOnline+' médico(s) disponível(is) · Espera: ~'+d.tempoEstimado+' min' : 'Atendimento disponível — aguarde um médico')
    : (d.mensagem || 'Indisponível no momento');
  var badge = document.getElementById('disp-status-badge');
  badge.className = 'dispon-status ' + (d.status||'verde');
  badge.querySelector('.dispon-dot').style.background = d.status==='verde'?'var(--g2)':d.status==='amarelo'?'#ffbd2e':'#ff8080';
  document.getElementById('disp-status-txt').textContent = d.disponivel ? (d.status==='amarelo'?'Alta demanda':'Disponível agora') : 'Indisponível';
  // Atendimento imediato disponível: mostra botão prosseguir
  document.getElementById('btnDispCont').style.display = d.disponivel ? 'block' : 'none';
  // Agendamentos: SEMPRE mostrar, independente de disponibilidade imediata
  document.getElementById('agend-section').style.display = 'block';
  renderHorarios(d.horariosAgendamento||[]);
  if(!d.disponivel && d.horarioRetorno) document.getElementById('disp-info').textContent=(d.mensagem||'Indisponível')+' · Próximo atendimento: '+d.horarioRetorno;
}

function renderHorarios(horarios){
  var grid = document.getElementById('horarios-grid'); horarioAgendado = null;
  document.getElementById('btnAgendar').disabled=true; document.getElementById('btnAgendar').classList.remove('on');
  if(!horarios.length){ grid.innerHTML='<p style="color:rgba(255,255,255,.4);font-size:.82rem">Nenhum horário disponível.</p>'; return; }
  grid.innerHTML = horarios.map(function(h){ return '<button class="horario-btn" onclick="selecionarHorario(this,\''+h.iso+'\')">'+h.label+'</button>'; }).join('');
}

function selecionarHorario(el, iso){
  document.querySelectorAll('.horario-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected'); horarioAgendado = iso;
  var btn = document.getElementById('btnAgendar'); btn.disabled=false; btn.classList.add('on');
}

function continuar_apos_disponibilidade(){ modoAgendamento=false; irParaPagamento(false); }
function prosseguirAgendamento(){ if(!horarioAgendado){ alert('Selecione um horário.'); return; } modoAgendamento=true; irParaPagamento(true); }

function irParaPagamento(agendamento){
  // Resetar estado do pagamento a cada entrada na tela
  paymentId = null; pixCode = '';
  clearInterval(paymentPoller);
  var qrSection = document.getElementById('pay-qr-section');
  qrSection.classList.remove('ativo');
  var btn = document.getElementById('payBtn');
  var btnConfirm = document.getElementById('payConfirmBtn');
  if(btnConfirm){ btnConfirm.disabled=false; btnConfirm.textContent='✅ Já realizei o pagamento'; }
  btn.style.display = 'block'; btn.disabled = false; btn.textContent = 'Ver Chave PIX  →';
  var statusEl = document.getElementById('pay-polling-status');
  statusEl.textContent = '⏳ Realize o pagamento e clique no botão abaixo';
  statusEl.className = 'pay-polling-status';

  showScreen('payment');
  document.getElementById('nav-step').textContent='PAGAMENTO';
  if(agendamento){
    var h = new Date(horarioAgendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    document.getElementById('pay-label-tipo').textContent='Agendamento — '+h;
    document.getElementById('pay-subtitulo').textContent='Pagamento para confirmar agendamento';
  } else {
    document.getElementById('pay-label-tipo').textContent='Consulta médica online';
    document.getElementById('pay-subtitulo').textContent='Pix instantâneo';
  }
}

// ── PAGAMENTO MANUAL PIX INTER ────────────────────────────────────────────────
// QR Code do Inter — coloque aqui a URL da imagem do QR ou base64
// Para obter: abra o app Inter → Pix → Cobrar → R$49,90 → salvar imagem do QR
// Ou use a chave Pix estática (CNPJ/email) sem imagem
var PIX_QR_IMG = '';
var PIX_CHAVE  = '55.789.896/0001-21';

async function gerarPagamento(){
  var nome = document.getElementById('payNome').value.trim();
  var tel  = document.getElementById('payTel').value.replace(/\D/g,'');
  var cpf  = document.getElementById('payCPF').value.trim();
  if(!nome){document.getElementById('payNome').focus();return;}
  if(!tel||tel.length<10){document.getElementById('payTel').focus();return;}
  if(!cpf){document.getElementById('payCPF').focus();return;}
  pacienteNome=nome; pacienteTel=tel; pacienteCPF=cpf;

  var btn = document.getElementById('payBtn');
  btn.disabled=true; btn.textContent='Carregando...';

  try{
    // Registra o interesse e obtém a chave Pix do servidor
    var res = await fetch(API+'/api/payment',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({nome})
    });
    var data = await res.json();
    if(!data.ok) throw new Error(data.error||'Erro ao iniciar pagamento');

    paymentId = data.payment_id;
    // Se o servidor retornar chave Pix, usa ela
    if(data.pix_chave) PIX_CHAVE = data.pix_chave;

    // Preenche campo copia e cola visível
    var inputChave = document.getElementById('pixChaveInput');
    if(inputChave) inputChave.value = PIX_CHAVE || '';

    // Exibe a imagem QR se disponível
    var qrImg = document.getElementById('pay-qr-img');
    if(PIX_QR_IMG){
      qrImg.src = PIX_QR_IMG;
      qrImg.style.display='block';
    } else {
      qrImg.style.display='none';
    }

    document.getElementById('pay-qr-section').classList.add('ativo');
    btn.style.display='none';

    // Pré-registro na fila (status='triagem' — NÃO aparece na fila do médico ainda)
    try{
      var rPre = await fetch(API+'/api/notify',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({nome:pacienteNome, tel:pacienteTel, tel_documentos:pacienteTelDoc,
          cpf:pacienteCPF, triagem:'(Aguardando pagamento)', tipo:tipoConsulta,
          data_nascimento:pacienteNascimento})
      });
      var dPre = await rPre.json();
      if(dPre.atendimentoId){
        atendimentoId = dPre.atendimentoId; salvarSessao();
        if(dPre.linkRetorno) history.replaceState(null,'',dPre.linkRetorno);
      }
    }catch(e){ console.warn('Pre-registro error:',e); }

  }catch(e){
    btn.disabled=false; btn.textContent='Ver Chave Pix →';
    var statusEl = document.getElementById('pay-polling-status');
    statusEl.textContent='❌ Erro ao carregar. Tente novamente.';
    statusEl.className='pay-polling-status err';
    console.error('Erro payment:',e);
  }
}

async function confirmarPagamentoManual(){
  var btn = document.getElementById('payConfirmBtn');
  btn.disabled=true; btn.textContent='Confirmando...';
  try{
    // Notifica o servidor que o paciente confirmou o pagamento
    await fetch(API+'/api/payment/confirmar-manual',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({paymentId, atendimentoId})
    });
  }catch(e){ console.warn('Confirmar manual error:',e); }

  // Independente da resposta do servidor, avança para triagem
  var statusEl = document.getElementById('pay-polling-status');
  statusEl.textContent='✅ Pagamento confirmado! Redirecionando...';
  statusEl.className='pay-polling-status ok';
  btn.textContent='✅ Confirmado!';

  await esperar(800);
  if(modoAgendamento){ await confirmarAgendamento(pacienteNome, pacienteTel, pacienteCPF); }
  else { continuarParaTriagem(); }
}

function copiarPix(){
  var chave = PIX_CHAVE || '';
  if(!chave) return;
  function ok(){ 
    var b=document.getElementById('payCopyBtn'); 
    var prev = b.innerHTML;
    b.textContent='✓ Copiado!'; 
    setTimeout(function(){ b.innerHTML=prev; }, 2000); 
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(chave).then(ok).catch(function(){fallbackCopy(chave);ok();}); }
  else{ fallbackCopy(chave); ok(); }
}



function fallbackCopy(text){
  var el=document.createElement('textarea'); el.value=text; el.style.position='fixed'; el.style.opacity='0';
  document.body.appendChild(el); el.select(); try{ document.execCommand('copy'); }catch(e){} document.body.removeChild(el);
}

function continuarParaTriagem(){
  showScreen('triage'); document.getElementById('nav-step').textContent='TRIAGEM MÉDICA'; startTriage();
}

async function confirmarAgendamento(nome,tel,cpf){
  try{
    var r1=await fetch(API+'/api/agendamento/criar',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({nome,tel,tel_documentos:pacienteTelDoc,cpf,modalidade:tipoConsulta,horario_agendado:horarioAgendado})});
    var d1=await r1.json();
    if(!d1.ok){ alert('Erro: '+(d1.error||'tente novamente')); return; }
    agendamentoId=d1.agendamentoId;
    var r2=await fetch(API+'/api/agendamento/confirmar',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({agendamentoId,paymentId:paymentId||''})});
    var d2=await r2.json(); var h=d2.horarioFormatado||'';
    // Agendamento confirmado — paciente faz triagem agora para o médico já ter as informações
    continuarParaTriagemAgendamento(h);
  }catch(e){ alert('Erro ao confirmar agendamento.'); }
}

function continuarParaTriagemAgendamento(horarioFormatado){
  // Guarda o horário para mostrar no final da triagem
  window._horarioAgendado = horarioFormatado;
  showScreen('triage');
  document.getElementById('nav-step').textContent='TRIAGEM MÉDICA';
  startTriageAgendamento();
}

function startTriageAgendamento(){
  triageHistory=[]; anamnesis={}; step=0;
  addMsg('triageChat','bot','Ótimo, '+(pacienteNome.split(' ')[0])+'! Agendamento confirmado para '+(window._horarioAgendado||'o horário escolhido')+'.\n\nEnquanto isso, me conta: qual é o problema que está sentindo? Assim o médico já chega preparado para te atender.');
  step=1; updateProgress(1);
}

// ── TRIAGEM ────────────────────────────────────────────────────────────────────

var triageHistory=[], anamnesis={}, step=0, pending=false;
var SYSTEM_TRIAGE='Você é um assistente de triagem do ConsultaJá24h. Nome e WhatsApp já coletados — NÃO peça novamente.\n\nConduza a anamnese em NO MÁXIMO 4 perguntas, uma por vez, em português brasileiro:\n\n1. Qual o problema principal\n2. Há quanto tempo, intensidade (0-10) e se tem febre\n3. Doenças crônicas, alergias, medicamentos em uso\n4. Precisa de atestado ou receita?\n\nRegras: UMA pergunta por vez. Linguagem simples e empática. Se emergência (dor no peito, falta de ar grave, desmaio), oriente pronto-socorro.\nQuando coletar tudo, responda SOMENTE com JSON: {"done":true,"summary":"[resumo formatado]"}';

function startTriage(){
  triageHistory=[]; anamnesis={}; step=0;
  addMsg('triageChat','bot','Olá, '+pacienteNome.split(' ')[0]+'! Sou o assistente de triagem da ConsultaJá24h.\nVou fazer algumas perguntas rápidas para ajudar o médico a entender melhor seu caso.\n\nQual é o problema que está sentindo?');
  step=1; updateProgress(1);
}
function addMsg(id,tipo,texto){
  var chat=document.getElementById(id); var div=document.createElement('div');
  div.className='msg msg--'+tipo;
  var safe=String(texto||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  var av=tipo==='bot'?'<div class="msg__av">&#x1F916;</div>':'<div class="msg__av">&#x1F464;</div>';
  var bub='<div class="msg__bubble">'+safe+'</div>';
  div.innerHTML=tipo==='bot'?av+bub:bub+av; chat.appendChild(div); chat.scrollTop=chat.scrollHeight;
}
function showTyping(id){
  var chat=document.getElementById(id); var div=document.createElement('div');
  div.className='msg msg--bot'; div.id=id+'-typ';
  div.innerHTML='<div class="msg__av">&#x1F916;</div><div class="msg__bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
  chat.appendChild(div); chat.scrollTop=chat.scrollHeight;
}
function removeTyping(id){var el=document.getElementById(id+'-typ');if(el)el.remove();}
function updateProgress(s){document.getElementById('progressFill').style.width=Math.min(Math.round(s/6*100),100)+'%';}
function setQR(opts){
  var box=document.getElementById('quickReplies'); box.innerHTML='';
  if(!opts||!opts.length)return;
  opts.forEach(function(o){var b=document.createElement('button');b.className='qr';b.textContent=o;b.onclick=function(){sendTriage(o);box.innerHTML='';};box.appendChild(b);});
}
async function sendTriage(text){
  if(!text||pending)return;
  pending=true; document.getElementById('triageSend').disabled=true;
  addMsg('triageChat','user',text);
  document.getElementById('triageInput').value=''; document.getElementById('triageInput').style.height='auto';
  setQR([]); step++; updateProgress(step); showTyping('triageChat');
  var reply=await callAPI('/api/triage',SYSTEM_TRIAGE,triageHistory,text);
  removeTyping('triageChat');
  try{
    var clean=String(reply).replace(/```json|```/g,'').trim();
    var parsed=JSON.parse(clean);
    if(parsed.done&&parsed.summary){
      anamnesis.summary=parsed.summary; updateProgress(6);
      addMsg('triageChat','bot','Triagem concluída! ✓\nAguarde enquanto você entra na fila.');
      await esperar(1200); finalizarTriagem();
      pending=false; document.getElementById('triageSend').disabled=false; return;
    }
  }catch(e){}
  addMsg('triageChat','bot',reply);
  if(step===2)setQR(['Masculino','Feminino','Prefiro não dizer']);
  if(step===3)setQR(['Sim, tenho febre','Não tenho febre']);
  if(step===4)setQR(['Não tenho','Sim, tenho']);
  if(step===5)setQR(['Apenas atestado','Apenas receita','Ambos','Nenhum']);
  pending=false; document.getElementById('triageSend').disabled=false;
}

async function finalizarTriagem(){
  // Mostra loading enquanto registra na fila
  addMsg('triageChat','bot','Registrando seu atendimento...');
  try{
    if(atendimentoId){
      // Atualiza o pré-registro com a triagem real → muda status para 'aguardando' → aparece na fila
      var r=await fetch(API+'/api/atendimento/atualizar-triagem',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({atendimentoId,triagem:anamnesis.summary||''})});
      var d=await r.json();
      if(!d.ok) throw new Error(d.error||'Erro ao registrar triagem');
    } else {
      // Sem pré-registro: cria direto com status 'aguardando'
      var r=await fetch(API+'/api/notify',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({nome:pacienteNome,tel:pacienteTel,tel_documentos:pacienteTelDoc,cpf:pacienteCPF,
          triagem:anamnesis.summary||'',tipo:tipoConsulta,data_nascimento:pacienteNascimento})});
      var d=await r.json();
      if(!d.ok) throw new Error(d.error||'Erro ao registrar');
      if(d.atendimentoId) atendimentoId=d.atendimentoId;
      if(d.linkRetorno) history.replaceState(null,'',d.linkRetorno);
    }
    salvarSessao();
    // Se for agendamento, mostra confirmação; se for imediato, vai para sala de espera
    if(modoAgendamento && agendamentoId){
      mostrarConfirmacaoAgendamento();
    } else {
      mostrarSalaEspera();
    }
  }catch(e){
    console.error('finalizarTriagem error:',e);
    // Remove mensagem de "registrando..."
    var chat=document.getElementById('triageChat');
    var last=chat.lastElementChild; if(last) last.remove();
    // Mostra erro e botão para tentar de novo
    addMsg('triageChat','bot','❌ Não conseguimos registrar seu atendimento. Verifique sua conexão e tente novamente.');
    var chat=document.getElementById('triageChat');
    var div=document.createElement('div'); div.style='padding:0 16px 16px';
    div.innerHTML='<button onclick="finalizarTriagem()" style="width:100%;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:Outfit,sans-serif;font-weight:700;font-size:.9rem;cursor:pointer">Tentar novamente</button>';
    chat.appendChild(div); chat.scrollTop=chat.scrollHeight;
  }
}

// ── SALA DE ESPERA ─────────────────────────────────────────────────────────────

function mostrarConfirmacaoAgendamento(){
  showScreen('espera');
  document.getElementById('nav-step').textContent='AGENDAMENTO CONFIRMADO';
  document.getElementById('esperaAnim').style.background='linear-gradient(135deg,rgba(66,133,244,.2),rgba(52,168,83,.15))';
  document.getElementById('esperaIcon').textContent='📅';
  document.getElementById('esperaTitulo').textContent='Tudo pronto!';
  var h = window._horarioAgendado || '';
  document.getElementById('esperaSub').textContent='Seu agendamento está confirmado'+(h?' para '+h:'')+'. O médico já terá sua triagem em mãos.';
  document.getElementById('esperaBadge').className='espera-badge video';
  document.getElementById('esperaBadgeIcon').textContent='📅';
  document.getElementById('esperaBadgeText').textContent='Agendado';
  document.getElementById('esperaStatusTxt').textContent='Você receberá contato no horário marcado.';
  // Para o polling — não precisa verificar status para agendamento
  clearInterval(esperaPoller);
}

function mostrarSalaEspera(){
  showScreen('espera'); document.getElementById('nav-step').textContent='AGUARDANDO MÉDICO';
  var badge=document.getElementById('esperaBadge'); badge.className='espera-badge '+tipoConsulta;
  document.getElementById('esperaBadgeIcon').textContent=tipoConsulta==='video'?'🎥':'💬';
  document.getElementById('esperaBadgeText').textContent=tipoConsulta==='video'?'Consulta por vídeo':'Consulta por chat';
  tentativas=0; verificarStatus(); esperaPoller=setInterval(verificarStatus,5000);
}

async function verificarStatus(){
  if(!atendimentoId){atualizarContador();return;}
  try{
    var res=await fetch(API+'/api/atendimento/status/'+atendimentoId);
    var data=await res.json(); if(!data.ok)return;
    atualizarContador(); var a=data.atendimento;
    if(a.status==='encerrado'){ clearInterval(esperaPoller); clearInterval(chatPoller); clearInterval(meetPoller); encerrarConsultaPaciente(); return; }
    if(a.status==='assumido'&&!chatAtivo&&!document.getElementById('meetWrap').classList.contains('ativo')){ clearInterval(esperaPoller); medicoAssumiu(a); }
  }catch(e){}
}

function atualizarContador(){
  tentativas++; var total=tentativas*5; var mins=Math.floor(total/60); var secs=total%60;
  var el=document.getElementById('esperaContador');
  if(el) el.textContent=(mins>0?mins+'min ':'')+secs+'s';
}

function medicoAssumiu(a){
  document.getElementById('esperaTitulo').textContent='Médico disponível!';
  document.getElementById('esperaSub').textContent='O médico assumiu seu atendimento.';
  document.getElementById('esperaIcon').textContent='✓';
  document.getElementById('esperaStatusTxt').textContent='';
  document.getElementById('esperaAnim').style.background='linear-gradient(135deg,rgba(94,224,160,.2),rgba(180,224,90,.15))';
  encerradoPoller=setInterval(async function(){
    try{
      var res=await fetch(API+'/api/atendimento/status/'+atendimentoId);
      var data=await res.json();
      if(data.ok&&data.atendimento.status==='encerrado'){ clearInterval(encerradoPoller); clearInterval(chatPoller); clearInterval(meetPoller); encerrarConsultaPaciente(); }
    }catch(e){}
  },8000);
  if(tipoConsulta==='chat') iniciarChatConsulta(a);
  else iniciarVideoConsulta(a);
}

function iniciarChatConsulta(atendimento){
  if(atendimento.medico_nome){
    document.getElementById('chatMedicoLabel').textContent=atendimento.medico_nome+' — pode enviar sua mensagem';
    document.getElementById('medicoNomeBanner').textContent=atendimento.medico_nome;
    document.getElementById('medicoEntrou').style.display='flex';
  }
  document.getElementById('chatConsulta').classList.add('ativo');
  carregarHistoricoChat().then(function(){ chatAtivo=true; chatPoller=setInterval(buscarMensagensNovas,3000); });
  var inp=document.getElementById('chatInputPaciente');
  inp.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();enviarMensagemChat();}});
}
async function carregarHistoricoChat(){
  if(!atendimentoId)return;
  try{ var res=await fetch(API+'/api/chat/'+atendimentoId); var data=await res.json();
    if(!data.ok)return; var msgs=data.mensagens||[];
    if(msgs.length>0){ msgs.forEach(function(m){renderMsgChat(m.autor,m.texto,m.criado_em);ultimaMsgId=m.id;}); }
  }catch(e){}
}
async function buscarMensagensNovas(){
  if(!atendimentoId||!chatAtivo)return;
  try{ var res=await fetch(API+'/api/chat/'+atendimentoId); var data=await res.json();
    if(!data.ok)return;
    (data.mensagens||[]).forEach(function(m){ if(m.id>ultimaMsgId){ if(m.autor==='medico') renderMsgChat(m.autor,m.texto,m.criado_em); ultimaMsgId=m.id; } });
  }catch(e){}
}
async function enviarMensagemChat(){
  var inp=document.getElementById('chatInputPaciente'); var texto=inp.value.trim();
  if(!texto||!atendimentoId)return;
  inp.value=''; inp.style.height='auto';
  renderMsgChat('paciente',texto,new Date().toISOString());
  try{
    var r=await fetch(API+'/api/chat/enviar',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({atendimentoId,autor:'paciente',texto})});
    var d=await r.json(); if(d.ok&&d.mensagem&&d.mensagem.id>ultimaMsgId) ultimaMsgId=d.mensagem.id;
  }catch(e){}
}
function renderMsgChat(autor,texto,timestamp){
  var msgs=document.getElementById('chatMsgs'); var div=document.createElement('div');
  div.className='cmsg '+autor;
  var hora=''; try{hora=new Date(timestamp).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}catch(e){}
  var av=autor==='medico'?'🩺':'🧑';
  var safe=String(texto).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  div.innerHTML='<div class="av">'+av+'</div><div class="bwrap"><div class="bub">'+safe+'</div><div class="ts">'+hora+'</div></div>';
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight;
}

function iniciarVideoConsulta(atendimento){
  if(atendimento.medico_nome){ document.getElementById('medicoNomeBannerVideo').textContent=atendimento.medico_nome; document.getElementById('medicoEntrouVideo').style.display='flex'; }
  document.getElementById('meetWrap').classList.add('ativo');
  if(atendimento.meet_link){ ativarLinkMeet(atendimento.meet_link); }
  else { meetPoller=setInterval(async function(){
    try{ var res=await fetch(API+'/api/atendimento/status/'+atendimentoId); var data=await res.json();
      if(data.ok&&data.atendimento.meet_link){clearInterval(meetPoller);ativarLinkMeet(data.atendimento.meet_link);}
    }catch(e){} },4000); }
}
function ativarLinkMeet(link){
  var btn=document.getElementById('btnMeetLink'); btn.href=link; btn.classList.remove('disabled');
  document.getElementById('meetAguardando').style.display='none';
}

function encerrarConsultaPaciente(){
  chatAtivo=false; clearInterval(chatPoller); clearInterval(meetPoller); clearInterval(encerradoPoller);
  var inp=document.getElementById('chatInputPaciente'); var sendBtn=document.getElementById('chatSendBtn');
  if(inp){inp.disabled=true; inp.placeholder='Consulta encerrada';}
  if(sendBtn) sendBtn.disabled=true;
  limparSessao(); mostrarTelaEncerrado();
}
function mostrarTelaEncerrado(){ showScreen('encerrado'); document.getElementById('nav-step').textContent='CONSULTA ENCERRADA'; }
function novaConsulta(){
  limparSessao(); atendimentoId=null; tipoConsulta=''; chatAtivo=false; ultimaMsgId=0;
  paymentId=null; pixCode=''; clearInterval(paymentPoller);
  history.replaceState(null,'','/triagem.html'); showScreen('identify');
  document.getElementById('nav-step').textContent='IDENTIFICAÇÃO';
}

// ── UTILS ──────────────────────────────────────────────────────────────────────

async function callAPI(endpoint,system,history,userMsg){
  history.push({role:'user',content:userMsg});
  try{
    var ctrl=new AbortController(); var t=setTimeout(function(){ctrl.abort();},35000);
    var res=await fetch(API+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system,messages:history}),signal:ctrl.signal});
    clearTimeout(t); if(!res.ok)throw new Error('HTTP '+res.status);
    var data=await res.json(); var text=data.text||'';
    if(!text)throw new Error('vazia');
    history.push({role:'assistant',content:text}); return text;
  }catch(e){
    history.pop();
    if(e.name==='AbortError')return 'O servidor demorou demais. Aguarde 30s e tente novamente.';
    return 'Erro de conexão. Verifique sua internet.';
  }
}
function esperar(ms){return new Promise(function(r){setTimeout(r,ms);});}

(function(){
  var ta=document.getElementById('triageInput');
  ta.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,110)+'px';});
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendTriage(this.value.trim());}});
  document.getElementById('triageSend').addEventListener('click',function(){sendTriage(ta.value.trim());});
})();

function mascaraData(el){
  var v=el.value.replace(/\D/g,'');
  if(v.length>8)v=v.slice(0,8);
  if(v.length>4) v=v.slice(0,2)+'/'+v.slice(2,4)+'/'+v.slice(4);
  else if(v.length>2) v=v.slice(0,2)+'/'+v.slice(2);
  el.value=v;
}
</script>
<script>gtag('event','conversion',{'send_to':'AW-17964942771/AT3gCPTl0PsbELOLrfZC','value':49.90,'currency':'BRL','transaction_id':''});</script>
</body>
</html>
