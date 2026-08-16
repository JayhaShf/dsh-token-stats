window.__ModuleLoader__.load({
	id: "dsh-token-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * Token 用量统计 — 设置页面板（浏览器半区）。
		 *
		 * 通过 settings.section 槽注入「Token 用量统计」设置区块，向宿主同源
		 * 接口 /tokens-api/stats 查询：累计/今日总量、按模型、按天、日期区间。
		 * 纯客户端读模型，不写任何配置；60 秒轮询刷新累计视图。
		 */
		let react = require("react");
		const React = react;

		const css = ".ts-root{display:flex;flex-direction:column;gap:12px;max-width:640px;width:100%;min-width:0}.ts-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.ts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;min-width:0}.ts-card-title{font-size:12px;color:var(--dsw-alias-label-secondary)}.ts-card-value{font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ts-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ts-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}.ts-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}.ts-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}.ts-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.ts-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap}.ts-btn:hover{border-color:var(--dsw-alias-border-l2)}.ts-btn.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}.ts-btn.primary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-weight:600}.ts-btn:disabled{opacity:.5;cursor:default}.ts-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);line-height:1.6}.ts-input{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 6px;font-size:12px;width:110px;box-sizing:border-box}.ts-block-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}.ts-table-wrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;min-width:0}.ts-table{width:100%;border-collapse:collapse;font-size:11px;background:var(--dsw-alias-bg-layer-1)}.ts-table th{text-align:left;padding:4px 6px;color:var(--dsw-alias-label-secondary);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}.ts-table td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}.ts-table tr:last-child td{border-bottom:none}.ts-table td.num{text-align:right}.ts-table th.num{text-align:right}.ts-model{font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis}.ts-chart{display:flex;align-items:flex-end;gap:8px;height:96px;padding:6px 2px 0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow-x:auto}.ts-chart-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%;min-width:34px}.ts-chart-bar{width:22px;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--dsw-alias-brand-primary),var(--dsw-alias-brand-primary-soft,var(--dsw-alias-brand-primary)));min-height:2px}.ts-chart-day{font-size:10px;color:var(--dsw-alias-label-secondary)}.ts-chart-val{font-size:10px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}";
		const tagId = "dsh-token-stats/ui.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-stats";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const h = React.createElement;

		function fmtTok(n) {
			if (!Number.isFinite(n) || n <= 0) return "0";
			if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + " 亿";
			if (n >= 1e6) return Math.round(n / 1e4) + " 万";
			if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + " 万";
			if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + " 千";
			return String(n);
		}
		function fmtInt(n) {
			return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}
		function todayStr() {
			const d = new Date();
			return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
		}
		function daysAgoStr(n) {
			const d = new Date();
			d.setDate(d.getDate() - n);
			return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
		}

		function api(path) {
			return fetch(path).then((r) => r.json());
		}

		function Breakdown(props) {
			const t = props.t || {};
			return h("div", { className: "ts-card-sub", title:
				"输入 " + fmtInt(t.inputTokens) + " · 输出 " + fmtInt(t.outputTokens) +
				" · 缓存读 " + fmtInt(t.cacheReadTokens) + " · 缓存写 " + fmtInt(t.cacheWriteTokens) +
				(t.reasoningTokens ? " · 推理 " + fmtInt(t.reasoningTokens) : "") },
				"输入 " + fmtTok(t.inputTokens),
				" · 输出 " + fmtTok(t.outputTokens),
				" · 缓存读 " + fmtTok(t.cacheReadTokens),
				" · 缓存写 " + fmtTok(t.cacheWriteTokens),
				t.reasoningTokens ? " · 推理 " + fmtTok(t.reasoningTokens) : null);
		}

		function Card(props) {
			return h("div", { className: "ts-card" },
				h("div", { className: "ts-card-title" }, props.title),
				h("div", { className: "ts-card-value", title: fmtInt(props.value) }, fmtTok(props.value)),
				props.sub ? props.sub : null);
		}

		const COL_HEAD = [
			["requests", "请求"],
			["inputTokens", "输入"],
			["outputTokens", "输出"],
			["cacheTokens", "缓存"],
			["totalTokens", "合计"],
		];
		function numCells(row) {
			return COL_HEAD.map(([key]) => {
				if (key === "cacheTokens") {
					const v = (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0);
					return h("td", {
						className: "num", key: key,
						title: "缓存读 " + fmtInt(row.cacheReadTokens || 0) + " · 缓存写 " + fmtInt(row.cacheWriteTokens || 0),
					}, fmtTok(v));
				}
				return h("td", { className: "num", key: key }, fmtTok(row[key]));
			});
		}

		function ModelTable(props) {
			const rows = props.rows || [];
			if (!rows.length) return h("div", { className: "ts-hint" }, "暂无数据");
			return h("div", { className: "ts-table-wrap" },
				h("table", { className: "ts-table" },
					h("thead", null, h("tr", null,
						h("th", null, "模型"),
						COL_HEAD.map(([key, label]) => h("th", { className: "num", key: key }, label)),
						h("th", { className: "num", key: "share" }, "占比"))),
					h("tbody", null, rows.map((row) =>
						h("tr", { key: row.model },
							h("td", { className: "ts-model", title: row.model }, row.model),
							numCells(row),
							h("td", { className: "num", title: fmtInt(row.totalTokens) + " / " + fmtInt(props.total) + " tokens" },
								(row.share || 0).toFixed(1) + "%"))))));
		}

		function DayTable(props) {
			const rows = props.rows || [];
			if (!rows.length) return h("div", { className: "ts-hint" }, "该区间暂无数据");
			return h("div", { className: "ts-table-wrap" },
				h("table", { className: "ts-table" },
					h("thead", null, h("tr", null,
						h("th", null, "日期"),
						COL_HEAD.map(([key, label]) => h("th", { className: "num", key: key }, label)))),
					h("tbody", null, rows.slice().reverse().map((row) =>
						h("tr", { key: row.day },
							h("td", null, row.day),
							numCells(row))))));
		}

		function BarChart(props) {
			const days = props.days || [];
			if (!days.length) return h("div", { className: "ts-hint" }, "暂无数据");
			const max = Math.max.apply(null, days.map((d) => d.totalTokens)) || 1;
			return h("div", { className: "ts-chart" },
				days.map((d) =>
					h("div", { className: "ts-chart-col", key: d.day, title: d.day + "：" + fmtInt(d.totalTokens) + " tokens（" + fmtInt(d.requests) + " 次请求）" },
						h("div", { className: "ts-chart-val" }, fmtTok(d.totalTokens)),
						h("div", { className: "ts-chart-bar", style: { height: Math.max(4, Math.round((d.totalTokens / max) * 64)) + "px" } }),
						h("div", { className: "ts-chart-day" }, d.day.slice(5)))));
		}

		function RangePanel(props) {
			const r = props.range;
			if (props.error) return h("div", { className: "ts-err" }, "查询失败：" + props.error);
			if (!r) return null;
			return h("div", { className: "ts-root" },
				h("div", { className: "ts-row" },
					h("span", { className: "ts-block-title" }, "区间统计：" + (r.from && r.to ? r.from + " ~ " + r.to : "全部时间")),
					h("span", { className: "ts-hint" }, "合计 " + fmtInt(r.totalTokens) + " tokens · " + fmtInt(r.requests) + " 次请求")),
				h("div", { className: "ts-cards" },
					h(Card, { title: "区间总 tokens", value: r.totalTokens, sub: h(Breakdown, { t: r }) }),
					h(Card, { title: "区间请求次数", value: r.requests, sub: h("div", { className: "ts-card-sub" }, "平均 " + fmtTok(r.requests ? Math.round(r.totalTokens / r.requests) : 0) + " tokens/请求") })),
				h("div", { className: "ts-block-title" }, "区间按模型"),
				h(ModelTable, { rows: r.models, total: r.totalTokens }),
				h("div", { className: "ts-block-title" }, "区间按天"),
				h(DayTable, { rows: r.days }));
		}

		function SettingsSection() {
			const [data, setData] = React.useState(null);
			const [err, setErr] = React.useState(null);
			const [from, setFrom] = React.useState(daysAgoStr(6));
			const [to, setTo] = React.useState(todayStr());
			const [range, setRange] = React.useState(null);
			const [rangeErr, setRangeErr] = React.useState(null);
			const [rangeHint, setRangeHint] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [rangeBusy, setRangeBusy] = React.useState(false);

			function loadOverall() {
				api("/tokens-api/stats").then((r) => {
					if (r && r.ok) { setData(r); setErr(null); }
					else setErr((r && r.error) || "加载失败");
				}).catch((e) => setErr(e && e.message ? e.message : String(e)));
			}

			React.useEffect(() => {
				loadOverall();
				const t = setInterval(loadOverall, 60000);
				return () => clearInterval(t);
			}, []);

			React.useEffect(() => {
				queryRange();
			}, []);

			function queryRange(f, t) {
				const fv = (f === undefined ? from : f).trim();
				const tv = (t === undefined ? to : t).trim();
				if (!fv && !tv) {
					// 日期为空：不静默执行，给出明确提示（面板保持当前内容）。
					setRangeHint("日期为空：当前面板显示全部时间统计，请选择日期范围后再查询。");
					return;
				}
				setRangeHint(null);
				setRangeBusy(true);
				setRangeErr(null);
				const q = (fv ? "from=" + encodeURIComponent(fv) : "") + (fv && tv ? "&" : "") + (tv ? "to=" + encodeURIComponent(tv) : "");
				api("/tokens-api/stats" + (q ? "?" + q : "")).then((r) => {
					if (r && r.ok) { setRange(r.range); setRangeErr(null); }
					else setRangeErr((r && r.error) || "查询失败");
				}).catch((e) => setRangeErr(e && e.message ? e.message : String(e)))
					.finally(() => setRangeBusy(false));
			}

			// 「全部」：清空日期并用累计数据渲染"全部时间"面板，点击即有明确反馈。
			function showAll() {
				setRangeHint(null);
				setRangeErr(null);
				if (o) {
					setRange({
						from: "", to: "", all: true,
						requests: o.requests,
						inputTokens: o.inputTokens,
						outputTokens: o.outputTokens,
						cacheReadTokens: o.cacheReadTokens,
						cacheWriteTokens: o.cacheWriteTokens,
						reasoningTokens: o.reasoningTokens,
						totalTokens: o.totalTokens,
						models: o.models,
						days: o.days,
					});
				} else {
					setRange(null);
				}
			}

			function preset(kind) {
				const today = todayStr();
				if (kind === "today") { setFrom(today); setTo(today); queryRange(today, today); }
				else if (kind === "7d") { const f = daysAgoStr(6); setFrom(f); setTo(today); queryRange(f, today); }
				else if (kind === "30d") { const f = daysAgoStr(29); setFrom(f); setTo(today); queryRange(f, today); }
				else { setFrom(""); setTo(""); showAll(); }
			}

			const o = data ? data.overall : null;
			const t = data ? data.today : null;
			const last7 = o && o.days ? o.days.slice(-7) : [];
			const today = todayStr();
			const dateEmpty = !from.trim() && !to.trim();
			const presets = {
				today: from === today && to === today,
				"7d": from === daysAgoStr(6) && to === today,
				"30d": from === daysAgoStr(29) && to === today,
				all: dateEmpty,
			};
			const presetBtn = (kind, label) => h("button", {
				className: "ts-btn" + (presets[kind] ? " active" : ""),
				onClick: () => preset(kind),
			}, label);

			return h("div", { className: "ts-root" },
				h("div", { className: "ts-row" },
					h("span", { className: "ts-block-title" }, "Token 用量统计"),
					h("button", { className: "ts-btn", onClick: () => { loadOverall(); if (dateEmpty) showAll(); else queryRange(); } }, "刷新")),
				err ? h("div", { className: "ts-err" }, "加载失败：" + err) : null,
				!data ? h("div", { className: "ts-hint" }, "加载中…") :
				h("div", { className: "ts-root", style: { gap: "10px" } },
					h("div", { className: "ts-cards" },
						h(Card, { title: "累计总 tokens", value: o.totalTokens, sub: h(Breakdown, { t: o }) }),
						h(Card, { title: "今日 tokens", value: t.totalTokens, sub: h(Breakdown, { t: t }) }),
						h(Card, { title: "累计请求次数", value: o.requests, sub: h("div", { className: "ts-card-sub" }, "覆盖 " + fmtInt(o.days.length) + " 天") }),
						h(Card, { title: "今日请求次数", value: t.requests, sub: h("div", { className: "ts-card-sub" }, "平均 " + fmtTok(t.requests ? Math.round(t.totalTokens / t.requests) : 0) + " tokens/请求") })),
					h("div", { className: "ts-row" },
						h("span", { className: "ts-block-title" }, "日期查询"),
						h("input", { className: "ts-input", type: "date", value: from, onChange: (e) => setFrom(e.target.value) }),
						h("span", { className: "ts-hint" }, "至"),
						h("input", { className: "ts-input", type: "date", value: to, onChange: (e) => setTo(e.target.value) }),
						presetBtn("today", "今天"),
						presetBtn("7d", "近7天"),
						presetBtn("30d", "近30天"),
						presetBtn("all", "全部"),
						h("button", {
							className: "ts-btn primary",
							onClick: queryRange,
							disabled: rangeBusy || dateEmpty,
							title: dateEmpty ? "日期为空，当前显示全部时间统计" : undefined,
						}, rangeBusy ? "查询中…" : "查询")),
					rangeHint ? h("div", { className: "ts-warn" }, rangeHint) : null,
					h(RangePanel, { range: range, error: rangeErr }),
					h("div", { className: "ts-block-title" }, "近 7 天用量"),
					h(BarChart, { days: last7 }),
					h("div", { className: "ts-block-title" }, "按模型（累计）"),
					h(ModelTable, { rows: o.models, total: o.totalTokens }),
					h("div", { className: "ts-block-title" }, "按天（累计）"),
					h(DayTable, { rows: o.days })),
				h("div", { className: "ts-hint" },
					"数据来源：提供方上报的 token 用量（assistant/chunk usage，assistant/message 兜底），含全部会话（含子代理与 Goal 轮次）。" +
					"持久化于 " + (data && data.meta ? data.meta.dataDir : "dataDir") + "/usage.jsonl，重启后自动恢复；" +
					"合计口径 = 输入 + 输出 + 缓存读 + 缓存写（推理为输出的细分项）。"));
		}

		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "token-stats", order: 20, label: "Token 用量统计" },
				SettingsSection));
		}
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
