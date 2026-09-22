'use strict';

/* =========================================================
   Focusline - chart engine

   Hand-rolled SVG. No dependencies, works from file://.

   Colours are written as `var(--viz-*)` in inline styles, so a theme
   change repaints every chart without a re-render. Only a width change
   re-renders.
   ========================================================= */

(function (global) {
  const NS = 'http://www.w3.org/2000/svg';

  /* Bars/columns: <= 24px thick, 4px rounded data-end, square at the baseline. */
  const BAR_MAX = 24;
  const BAR_RADIUS = 4;
  const LINE_WIDTH = 2;
  const MARKER_RADIUS = 4.5;
  const SURFACE_GAP = 2;
  const HIT_MIN = 24;

  /* ---------------------------------------------------------
     Small DOM helpers
     --------------------------------------------------------- */
  function svg(tag, attrs, styles) {
    const node = document.createElementNS(NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] === null || attrs[key] === undefined) return;
        node.setAttribute(key, String(attrs[key]));
      });
    }
    if (styles) Object.keys(styles).forEach(function (key) { node.style[key] = styles[key]; });
    return node;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    /* Category names are user-typed data: always textContent, never innerHTML. */
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* ---------------------------------------------------------
     Formatting
     --------------------------------------------------------- */
  function formatMinutes(minutes) {
    const value = Math.round(minutes);
    if (value < 60) return value + 'm';
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? hours + 'h' : hours + 'h ' + String(rest).padStart(2, '0') + 'm';
  }

  function formatCompact(value) {
    if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(value * 10) / 10);
  }

  /* Axis ticks land on clean numbers so they can carry the values
     that are not directly labelled. */
  function niceTicks(max, count) {
    if (!(max > 0)) return { ticks: [0], top: 1 };
    const rough = max / Math.max(1, count);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const candidates = [1, 2, 2.5, 5, 10];
    let step = magnitude;
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index] * magnitude >= rough) { step = candidates[index] * magnitude; break; }
      step = candidates[index] * magnitude;
    }
    return buildTicks(max, step);
  }

  /* A minutes axis is read as time, so its steps come off a clock ladder:
     "1h 40m" is a round number and still a terrible gridline. */
  const TIME_STEPS = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 1440, 2880, 4320];

  function niceTimeTicks(max, count) {
    if (!(max > 0)) return { ticks: [0], top: 1 };
    const rough = max / Math.max(1, count);
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (let index = 0; index < TIME_STEPS.length; index += 1) {
      if (TIME_STEPS[index] >= rough) { step = TIME_STEPS[index]; break; }
    }
    return buildTicks(max, step);
  }

  function buildTicks(max, step) {
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value * 1000) / 1000);
    return { ticks: ticks, top: top || 1 };
  }

  /* ---------------------------------------------------------
     Shared tooltip - one node for every chart on the page
     --------------------------------------------------------- */
  let tipNode = null;

  function tooltip() {
    if (!tipNode) {
      tipNode = el('div', 'chart-tip');
      tipNode.setAttribute('role', 'presentation');
      document.body.append(tipNode);
    }
    return tipNode;
  }

  /* rows: [{ label, value, color }] - the value leads, the series name follows. */
  function showTip(anchorRect, title, rows) {
    const tip = tooltip();
    tip.replaceChildren();
    tip.append(el('p', 'chart-tip-title', title));

    rows.forEach(function (row) {
      const line = el('p', 'chart-tip-row');
      if (row.color) {
        const key = el('span', 'chart-tip-key');
        key.style.background = row.color;
        line.append(key);
      }
      line.append(el('strong', null, row.value));
      if (row.label) line.append(el('span', null, row.label));
      tip.append(line);
    });

    tip.classList.add('show');

    /* Place above the mark, flipping below and clamping to the viewport. */
    const box = tip.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.left + anchorRect.width / 2 - box.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
    let top = anchorRect.top - box.height - 10;
    if (top < margin) top = anchorRect.bottom + 10;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip() {
    if (tipNode) tipNode.classList.remove('show');
  }

  global.addEventListener('scroll', hideTip, true);
  global.addEventListener('resize', hideTip);

  /* Wires hover AND keyboard focus to the same readout, so a tooltip
     never becomes the only route to a value. */
  function bindReadout(node, title, rows) {
    function open() { showTip(node.getBoundingClientRect(), title, rows); }
    node.addEventListener('pointerenter', open);
    node.addEventListener('focus', open);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('blur', hideTip);
  }

  /* ---------------------------------------------------------
     Paths
     --------------------------------------------------------- */
  /* Rounded at the data end, square at the baseline. */
  function columnPath(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height));
    const bottom = y + height;
    return 'M' + x + ' ' + bottom
      + 'L' + x + ' ' + (y + r)
      + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y
      + 'L' + (x + width - r) + ' ' + y
      + 'Q' + (x + width) + ' ' + y + ' ' + (x + width) + ' ' + (y + r)
      + 'L' + (x + width) + ' ' + bottom + 'Z';
  }

  function barPathRight(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, height / 2, width));
    const right = x + width;
    return 'M' + x + ' ' + y
      + 'L' + (right - r) + ' ' + y
      + 'Q' + right + ' ' + y + ' ' + right + ' ' + (y + r)
      + 'L' + right + ' ' + (y + height - r)
      + 'Q' + right + ' ' + (y + height) + ' ' + (right - r) + ' ' + (y + height)
      + 'L' + x + ' ' + (y + height) + 'Z';
  }

  function linePath(points) {
    return points.map(function (point, index) {
      return (index === 0 ? 'M' : 'L') + point[0] + ' ' + point[1];
    }).join('');
  }

  /* ---------------------------------------------------------
     Chart chrome shared by the cartesian charts
     --------------------------------------------------------- */
  function drawYAxis(root, scale, box, formatter) {
    scale.ticks.forEach(function (value) {
      const y = box.top + box.height - (value / scale.top) * box.height;
      root.append(svg('line', {
        x1: box.left, x2: box.left + box.width, y1: y, y2: y,
        'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }, { stroke: value === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)' }));

      const label = svg('text', {
        x: box.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'viz-tick'
      }, { fill: 'var(--viz-muted)' });
      label.textContent = formatter ? formatter(value) : formatCompact(value);
      root.append(label);
    });
  }

  /* Thins x labels until they stop colliding. */
  function labelStride(count, bandWidth, approxLabelWidth) {
    if (!(bandWidth > 0)) return Math.max(1, count);
    let stride = Math.max(1, Math.ceil((approxLabelWidth + 12) / bandWidth));
    while (count / stride > 12) stride += 1;
    return stride;
  }

  /* ---------------------------------------------------------
     Table view - the WCAG-clean twin every chart carries
     --------------------------------------------------------- */
  function buildTable(columns, rows) {
    const table = el('table', 'chart-table');
    const head = el('thead');
    const headRow = el('tr');
    columns.forEach(function (column, index) {
      const cell = el('th', index === 0 ? null : 'num', column);
      cell.setAttribute('scope', 'col');
      headRow.append(cell);
    });
    head.append(headRow);
    table.append(head);

    const body = el('tbody');
    rows.forEach(function (row) {
      const line = el('tr');
      row.forEach(function (value, index) {
        if (index === 0) {
          const cell = el('th', null, value);
          cell.setAttribute('scope', 'row');
          line.append(cell);
        } else {
          line.append(el('td', 'num', value));
        }
      });
      body.append(line);
    });
    table.append(body);
    return table;
  }

  /* ---------------------------------------------------------
     Chart host: header, plot, legend, table toggle, resize
     --------------------------------------------------------- */
  const live = [];

  function Chart(container, options) {
    this.container = container;
    this.options = options || {};
    this.spec = null;
    this.width = 0;

    container.replaceChildren();
    container.classList.add('chart-card');

    const header = el('div', 'chart-head');
    const titles = el('div', 'chart-titles');
    titles.append(el('h3', 'chart-title', this.options.title || ''));
    if (this.options.subtitle) titles.append(el('p', 'chart-sub', this.options.subtitle));
    header.append(titles);

    this.toggle = el('button', 'chart-toggle', 'Table');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-pressed', 'false');
    header.append(this.toggle);
    container.append(header);

    this.legend = el('div', 'chart-legend');
    container.append(this.legend);

    this.plot = el('div', 'chart-plot');
    container.append(this.plot);

    this.note = el('p', 'chart-note');
    container.append(this.note);

    this.tableWrap = el('div', 'chart-table-wrap');
    container.append(this.tableWrap);

    const self = this;
    this.toggle.addEventListener('click', function () {
      const showing = container.classList.toggle('show-table');
      self.toggle.setAttribute('aria-pressed', String(showing));
      self.toggle.textContent = showing ? 'Chart' : 'Table';
      hideTip();
    });

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(function () {
        const width = Math.round(self.plot.clientWidth);
        if (!width || Math.abs(width - self.width) < 8) return;
        self.width = width;
        self.paint();
      });
      this.observer.observe(this.plot);
    } else {
      global.addEventListener('resize', function () { self.width = 0; self.paint(); });
    }

    live.push(this);
  }

  Chart.prototype.update = function (spec) {
    this.spec = spec;
    this.paint();
  };

  Chart.prototype.setLegend = function (entries, force) {
    this.legend.replaceChildren();
    /* A single series needs no legend box - the title already names it.
       `force` covers the split, where the lone slice still needs naming. */
    if (!entries || (entries.length < 2 && !force)) {
      this.legend.hidden = true;
      return;
    }
    this.legend.hidden = false;
    entries.forEach(function (entry) {
      const item = el('span', 'chart-legend-item');
      const key = el('span', entry.shape === 'line' ? 'legend-line' : 'legend-swatch');
      key.style.background = entry.color;
      item.append(key, el('span', null, entry.label));
      this.legend.append(item);
    }, this);
  };

  Chart.prototype.empty = function (message) {
    this.plot.replaceChildren(el('p', 'chart-empty', message));
    this.legend.hidden = true;
    this.note.textContent = '';
    this.note.hidden = true;
    this.tableWrap.replaceChildren();
    this.container.classList.add('is-empty');
  };

  Chart.prototype.paint = function () {
    if (!this.spec) return;
    const width = Math.round(this.plot.clientWidth) || this.width;
    if (!width) return;
    this.width = width;
    this.container.classList.remove('is-empty');
    this.note.textContent = this.spec.note || '';
    this.note.hidden = !this.spec.note;
    RENDERERS[this.spec.type].call(this, width);
  };

  function refreshAll() {
    live.forEach(function (chart) {
      chart.width = 0;
      chart.paint();
    });
  }

  /* =========================================================
     Renderers
     ========================================================= */
  const RENDERERS = {};

  /* ---------------------------------------------------------
     1. Columns + trend line (+ optional goal reference)

     Both series are minutes on one axis - never a second y-scale.
     --------------------------------------------------------- */
  RENDERERS.trend = function (width) {
    const spec = this.spec;
    const points = spec.points;

    const hasValue = points.some(function (point) { return point.value > 0; });
    if (!points.length || !hasValue) return this.empty(spec.emptyMessage || 'No sessions in this range yet.');

    const box = { left: 44, top: 14, right: 10, bottom: 26 };
    const plotWidth = Math.max(40, width - box.left - box.right);
    const plotHeight = spec.height || 190;
    /* The container includes the x-axis band, so the card never grows a scrollbar. */
    const height = plotHeight + box.top + box.bottom;

    const maxValue = Math.max(
      spec.goal || 0,
      points.reduce(function (top, point) {
        return Math.max(top, point.value, point.trend || 0);
      }, 0)
    );
    const scale = niceTimeTicks(maxValue, 4);
    const area = { left: box.left, top: box.top, width: plotWidth, height: plotHeight };

    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': spec.ariaLabel || this.options.title
    });

    drawYAxis(root, scale, area, formatMinutes);

    const band = plotWidth / points.length;
    const barWidth = Math.max(3, Math.min(BAR_MAX, band - SURFACE_GAP * 2));
    const yOf = function (value) { return area.top + area.height - (value / scale.top) * area.height; };

    /* The crosshair sits under the marks so it never tints them. */
    const crosshair = svg('rect', {
      x: area.left, y: area.top, width: band, height: area.height
    }, { fill: 'var(--viz-hover)', opacity: '0', pointerEvents: 'none', transition: 'opacity .12s ease' });
    root.append(crosshair);

    /* Goal: a recessive hairline, labelled once at the right. */
    if (spec.goal > 0 && spec.goal <= scale.top) {
      const goalY = yOf(spec.goal);
      root.append(svg('line', {
        x1: area.left, x2: area.left + area.width, y1: goalY, y2: goalY, 'stroke-width': 1
      }, { stroke: 'var(--viz-s1)', opacity: '0.45' }));
      const goalLabel = svg('text', {
        x: area.left + area.width, y: goalY - 5, 'text-anchor': 'end', class: 'viz-annotation'
      }, { fill: 'var(--viz-muted)' });
      goalLabel.textContent = 'goal ' + formatMinutes(spec.goal);
      root.append(goalLabel);
    }

    /* Columns */
    points.forEach(function (point, index) {
      if (!(point.value > 0)) return;
      const x = area.left + band * index + (band - barWidth) / 2;
      const y = yOf(point.value);
      const barHeight = area.top + area.height - y;
      root.append(svg('path', {
        d: columnPath(x, y, barWidth, barHeight, BAR_RADIUS)
      }, { fill: 'var(--viz-s1)', opacity: point.muted ? '0.45' : '1' }));
    });

    /* 7-day trend line, drawn over the columns */
    const trendPoints = [];
    points.forEach(function (point, index) {
      if (point.trend === null || point.trend === undefined) return;
      trendPoints.push([area.left + band * index + band / 2, yOf(point.trend)]);
    });

    if (trendPoints.length > 1) {
      root.append(svg('path', {
        d: linePath(trendPoints), fill: 'none', 'stroke-width': LINE_WIDTH,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }, { stroke: 'var(--viz-s2)' }));

      const last = trendPoints[trendPoints.length - 1];
      /* 2px surface ring keeps the end marker legible over a column. */
      root.append(svg('circle', {
        cx: last[0], cy: last[1], r: MARKER_RADIUS + SURFACE_GAP
      }, { fill: 'var(--viz-surface)' }));
      root.append(svg('circle', {
        cx: last[0], cy: last[1], r: MARKER_RADIUS
      }, { fill: 'var(--viz-s2)' }));
    }

    /* X labels, thinned until they stop colliding */
    const stride = labelStride(points.length, band, 34);
    points.forEach(function (point, index) {
      if (index % stride !== 0 && index !== points.length - 1) return;
      if (index !== points.length - 1 && points.length - 1 - index < stride * 0.6) return;
      const label = svg('text', {
        x: area.left + band * index + band / 2,
        y: area.top + area.height + 16,
        'text-anchor': 'middle', class: 'viz-tick'
      }, { fill: 'var(--viz-muted)' });
      label.textContent = point.short;
      root.append(label);
    });

    /* Hit layer: the whole column band, so the reader aims at a date. */
    points.forEach(function (point, index) {
      const hitWidth = Math.max(band, 1);
      const hit = svg('rect', {
        x: area.left + band * index, y: area.top,
        width: hitWidth, height: area.height,
        fill: 'transparent', tabindex: '0', role: 'img',
        'aria-label': point.label + ': ' + formatMinutes(point.value) + ' of focus'
      }, { cursor: 'pointer', outline: 'none' });

      const rows = [{ value: formatMinutes(point.value), label: 'focused', color: 'var(--viz-s1)' }];
      if (point.trend !== null && point.trend !== undefined) {
        rows.push({ value: formatMinutes(point.trend), label: '7-day average', color: 'var(--viz-s2)' });
      }
      if (point.sessions) rows.push({ value: String(point.sessions), label: 'sessions' });
      bindReadout(hit, point.label, rows);

      /* Crosshair + a lift on the hovered column. */
      hit.addEventListener('pointerenter', function () { crosshair.setAttribute('x', String(area.left + band * index)); crosshair.style.opacity = '1'; });
      hit.addEventListener('focus', function () { crosshair.setAttribute('x', String(area.left + band * index)); crosshair.style.opacity = '1'; });
      hit.addEventListener('pointerleave', function () { crosshair.style.opacity = '0'; });
      hit.addEventListener('blur', function () { crosshair.style.opacity = '0'; });
      root.append(hit);
    });

    this.plot.replaceChildren(root);
    this.setLegend([
      { label: 'Focus per day', color: 'var(--viz-s1)' },
      { label: '7-day average', color: 'var(--viz-s2)', shape: 'line' }
    ]);
    this.tableWrap.replaceChildren(buildTable(
      ['Day', 'Focus', '7-day avg', 'Sessions'],
      points.map(function (point) {
        return [
          point.label,
          formatMinutes(point.value),
          point.trend === null || point.trend === undefined ? '-' : formatMinutes(point.trend),
          String(point.sessions || 0)
        ];
      })
    ));
  };

  /* ---------------------------------------------------------
     2. Consistency calendar (sequential heat)

     Level 0 is the neutral track - "nothing here", not a data step.
     Levels 1-4 are the validated one-hue ramp.
     --------------------------------------------------------- */
  RENDERERS.calendar = function (width) {
    const spec = this.spec;
    const days = spec.days;
    const litDays = days.some(function (day) { return day.minutes > 0; });
    if (!days.length || !litDays) return this.empty(spec.emptyMessage || 'No history yet.');

    const rows = 7;
    const weeks = Math.ceil(days.length / rows);
    const gap = 3;
    const top = 16;
    const cell = Math.max(7, Math.min(15, Math.floor((width - 26 - gap * (weeks - 1)) / weeks)));
    const left = 26;
    const height = top + rows * cell + (rows - 1) * gap + 4;

    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': spec.ariaLabel || this.options.title
    });

    /* Weekday gutter: Mon / Wed / Fri only, so it never crowds the grid.
       Row 0 is Monday - the grid always starts on one. */
    ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach(function (name, index) {
      if (!name) return;
      const label = svg('text', {
        x: 0, y: top + index * (cell + gap) + cell / 2 + 3, class: 'viz-tick'
      }, { fill: 'var(--viz-muted)' });
      label.textContent = name;
      root.append(label);
    });

    /* Month labels are decided per column, not per cell: a month whose 1st
       falls late in the week still gets named, and two of them never
       collide at the top of the grid. */
    let lastMonth = -1;
    let lastLabelX = -Infinity;
    for (let week = 0; week < weeks; week += 1) {
      const first = days[week * rows];
      if (!first) continue;
      const x = left + week * (cell + gap);
      if (first.date.getMonth() === lastMonth) continue;
      lastMonth = first.date.getMonth();
      if (x - lastLabelX < 30) continue;
      lastLabelX = x;
      const label = svg('text', { x: x, y: 9, class: 'viz-tick' }, { fill: 'var(--viz-muted)' });
      label.textContent = first.monthShort;
      root.append(label);
    }

    days.forEach(function (day, index) {
      if (day.outside) return;
      const week = Math.floor(index / rows);
      const row = index % rows;
      const x = left + week * (cell + gap);
      const y = top + row * (cell + gap);

      const rect = svg('rect', {
        x: x, y: y, width: cell, height: cell, rx: 2, class: 'viz-mark',
        tabindex: '0', role: 'img',
        'aria-label': day.label + ': ' + (day.minutes ? formatMinutes(day.minutes) + ' of focus' : 'no focus')
      }, {
        fill: day.level === 0 ? 'var(--viz-track)' : 'var(--viz-heat-' + day.level + ')',
        cursor: 'pointer', outline: 'none'
      });

      const readout = [];
      readout.push({ value: day.minutes ? formatMinutes(day.minutes) : 'No focus', label: day.minutes ? 'focused' : '' });
      if (day.sessions) readout.push({ value: String(day.sessions), label: 'sessions' });
      bindReadout(rect, day.label, readout);
      root.append(rect);
    });

    this.plot.replaceChildren(root);
    this.setLegend(null);

    /* Scale legend for the continuous encoding. */
    const scale = el('div', 'heat-scale');
    scale.append(el('span', null, 'Less'));
    [0, 1, 2, 3, 4].forEach(function (level) {
      const chip = el('span', 'heat-chip');
      chip.style.background = level === 0 ? 'var(--viz-track)' : 'var(--viz-heat-' + level + ')';
      scale.append(chip);
    });
    scale.append(el('span', null, 'More'));
    this.plot.append(scale);

    this.tableWrap.replaceChildren(buildTable(
      ['Day', 'Focus', 'Sessions'],
      days.filter(function (day) { return !day.outside && day.minutes > 0; })
        .reverse()
        .map(function (day) { return [day.label, formatMinutes(day.minutes), String(day.sessions)]; })
    ));
  };

  /* ---------------------------------------------------------
     3. Columns (best hours, weekday rhythm)

     One series, one hue - magnitude is the job, so no categorical
     colours and no legend. The extreme is direct-labelled.
     --------------------------------------------------------- */
  RENDERERS.columns = function (width) {
    const spec = this.spec;
    const bars = spec.bars;
    const total = bars.reduce(function (sum, bar) { return sum + bar.value; }, 0);
    if (!total) return this.empty(spec.emptyMessage || 'Not enough sessions yet.');

    const box = { left: spec.hideYAxis ? 6 : 44, top: 18, right: 8, bottom: 24 };
    const plotWidth = Math.max(40, width - box.left - box.right);
    const plotHeight = spec.height || 150;
    const height = plotHeight + box.top + box.bottom;
    const area = { left: box.left, top: box.top, width: plotWidth, height: plotHeight };

    const maxValue = bars.reduce(function (top, bar) { return Math.max(top, bar.value); }, 0);
    const scale = spec.timeScale === false ? niceTicks(maxValue, 3) : niceTimeTicks(maxValue, 3);

    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': spec.ariaLabel || this.options.title
    });

    if (!spec.hideYAxis) {
      drawYAxis(root, scale, area, spec.tickFormat || formatMinutes);
    } else {
      root.append(svg('line', {
        x1: area.left, x2: area.left + area.width,
        y1: area.top + area.height, y2: area.top + area.height,
        'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }, { stroke: 'var(--viz-axis)' }));
    }

    const band = plotWidth / bars.length;
    const barWidth = Math.max(3, Math.min(BAR_MAX, band - SURFACE_GAP * 2));
    const peak = bars.reduce(function (best, bar, index) {
      return bar.value > bars[best].value ? index : best;
    }, 0);

    /* Hover band, under the marks, so a hovered column visibly responds. */
    const hover = svg('rect', {
      x: area.left, y: area.top, width: band, height: area.height
    }, { fill: 'var(--viz-hover)', opacity: '0', pointerEvents: 'none', transition: 'opacity .12s ease' });
    root.append(hover);

    bars.forEach(function (bar, index) {
      const x = area.left + band * index + (band - barWidth) / 2;
      if (bar.value > 0) {
        const y = area.top + area.height - (bar.value / scale.top) * area.height;
        root.append(svg('path', {
          d: columnPath(x, y, barWidth, area.top + area.height - y, BAR_RADIUS)
        }, { fill: 'var(--viz-s1)' }));

        /* Label the extreme only - a number on every column goes unread. */
        if (index === peak && spec.labelPeak !== false) {
          const label = svg('text', {
            x: x + barWidth / 2, y: y - 6, 'text-anchor': 'middle', class: 'viz-annotation'
          }, { fill: 'var(--viz-ink2)' });
          label.textContent = (spec.tickFormat || formatMinutes)(bar.value);
          root.append(label);
        }
      }

      const hit = svg('rect', {
        x: area.left + band * index, y: area.top, width: band, height: area.height,
        fill: 'transparent', tabindex: '0', role: 'img',
        'aria-label': bar.label + ': ' + (spec.tickFormat || formatMinutes)(bar.value)
      }, { cursor: 'pointer', outline: 'none' });
      const rows = [{ value: (spec.tickFormat || formatMinutes)(bar.value), label: spec.valueLabel || 'focused', color: 'var(--viz-s1)' }];
      if (bar.detail) rows.push({ value: bar.detail, label: bar.detailLabel || '' });
      bindReadout(hit, bar.label, rows);

      function lift() { hover.setAttribute('x', String(area.left + band * index)); hover.style.opacity = '1'; }
      function drop() { hover.style.opacity = '0'; }
      hit.addEventListener('pointerenter', lift);
      hit.addEventListener('focus', lift);
      hit.addEventListener('pointerleave', drop);
      hit.addEventListener('blur', drop);
      root.append(hit);
    });

    const stride = spec.labelStride || labelStride(bars.length, band, 26);
    bars.forEach(function (bar, index) {
      if (index % stride !== 0 || !bar.short) return;
      const label = svg('text', {
        x: area.left + band * index + band / 2, y: area.top + area.height + 15,
        'text-anchor': 'middle', class: 'viz-tick'
      }, { fill: index === peak ? 'var(--viz-ink2)' : 'var(--viz-muted)' });
      label.textContent = bar.short;
      root.append(label);
    });

    this.plot.replaceChildren(root);
    this.setLegend(null);
    this.tableWrap.replaceChildren(buildTable(
      [spec.categoryHeading || 'Slot', spec.valueHeading || 'Focus'],
      bars.map(function (bar) { return [bar.label, (spec.tickFormat || formatMinutes)(bar.value)]; })
    ));
  };

  /* ---------------------------------------------------------
     4. Stacked bar (where the focus went)

     Part-to-whole with categorical identity. 2px surface gaps do the
     separating; a legend is always present; inside labels only render
     when they actually fit.
     --------------------------------------------------------- */
  RENDERERS.split = function (width) {
    const spec = this.spec;
    const slices = spec.slices;
    const total = slices.reduce(function (sum, slice) { return sum + slice.value; }, 0);
    if (!total) return this.empty(spec.emptyMessage || 'Tag a few sessions to see the split.');

    const barHeight = 34;
    const height = barHeight + 4;
    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': spec.ariaLabel || this.options.title
    });

    let cursor = 0;
    slices.forEach(function (slice, index) {
      const raw = (slice.value / total) * width;
      const isLast = index === slices.length - 1;
      /* The gap is carved out of the segment, so widths still sum to the whole. */
      const segWidth = Math.max(2, raw - (isLast ? 0 : SURFACE_GAP));
      const x = cursor;

      const path = isLast
        ? barPathRight(x, 2, segWidth, barHeight, BAR_RADIUS)
        : 'M' + x + ' 2h' + segWidth + 'v' + barHeight + 'h-' + segWidth + 'Z';

      const node = svg('path', {
        d: path, tabindex: '0', role: 'img', class: 'viz-mark',
        'aria-label': slice.label + ': ' + formatMinutes(slice.value)
          + ', ' + Math.round((slice.value / total) * 100) + '%'
      }, { fill: slice.color, cursor: 'pointer', outline: 'none' });

      bindReadout(node, slice.label, [
        { value: formatMinutes(slice.value), label: 'focused', color: slice.color },
        { value: Math.round((slice.value / total) * 100) + '%', label: 'of the range' }
      ]);
      root.append(node);

      /* No inline label: an interior segment has no free end, and a small
         bold percentage on a mid-tone fill sits under the contrast floor.
         The legend, tooltip and table carry every value instead. */
      cursor += raw;
    });

    this.plot.replaceChildren(root);
    this.setLegend(slices.map(function (slice) {
      return { label: slice.label + ' · ' + formatMinutes(slice.value), color: slice.color };
    }), true);
    this.tableWrap.replaceChildren(buildTable(
      ['Project', 'Focus', 'Share', 'Sessions'],
      slices.map(function (slice) {
        return [
          slice.label, formatMinutes(slice.value),
          Math.round((slice.value / total) * 100) + '%',
          String(slice.sessions || 0)
        ];
      })
    ));
  };

  /* ---------------------------------------------------------
     5. Line (interruptions per focus hour)
     --------------------------------------------------------- */
  RENDERERS.line = function (width) {
    const spec = this.spec;
    const points = spec.points;
    const anyValue = points.some(function (point) { return point.value !== null; });
    if (!points.length || !anyValue) return this.empty(spec.emptyMessage || 'Not enough sessions yet.');

    const box = { left: 36, top: 16, right: 14, bottom: 24 };
    const plotWidth = Math.max(40, width - box.left - box.right);
    const plotHeight = spec.height || 130;
    const height = plotHeight + box.top + box.bottom;
    const area = { left: box.left, top: box.top, width: plotWidth, height: plotHeight };

    const maxValue = points.reduce(function (top, point) {
      return Math.max(top, point.value === null ? 0 : point.value);
    }, 0);
    const scale = niceTicks(Math.max(maxValue, 1), 3);
    const format = spec.tickFormat || function (value) { return String(Math.round(value * 10) / 10); };

    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': spec.ariaLabel || this.options.title
    });

    drawYAxis(root, scale, area, format);

    const step = points.length > 1 ? area.width / (points.length - 1) : 0;
    const xOf = function (index) { return area.left + step * index; };
    const yOf = function (value) { return area.top + area.height - (value / scale.top) * area.height; };

    const drawn = [];
    points.forEach(function (point, index) {
      if (point.value === null) return;
      drawn.push([xOf(index), yOf(point.value)]);
    });

    if (drawn.length > 1) {
      /* Area wash at ~10%, never a saturated block. */
      const fill = linePath(drawn)
        + 'L' + drawn[drawn.length - 1][0] + ' ' + (area.top + area.height)
        + 'L' + drawn[0][0] + ' ' + (area.top + area.height) + 'Z';
      root.append(svg('path', { d: fill }, { fill: 'var(--viz-s1)', opacity: '0.1' }));
      root.append(svg('path', {
        d: linePath(drawn), fill: 'none', 'stroke-width': LINE_WIDTH,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }, { stroke: 'var(--viz-s1)' }));
    }

    if (drawn.length) {
      const last = drawn[drawn.length - 1];
      root.append(svg('circle', { cx: last[0], cy: last[1], r: MARKER_RADIUS + SURFACE_GAP }, { fill: 'var(--viz-surface)' }));
      root.append(svg('circle', { cx: last[0], cy: last[1], r: MARKER_RADIUS }, { fill: 'var(--viz-s1)' }));

      /* Direct-label the endpoint; the axis carries the rest. */
      const lastPoint = points[points.length - 1];
      if (lastPoint && lastPoint.value !== null) {
        const label = svg('text', {
          x: Math.min(last[0], area.left + area.width) - 2,
          y: last[1] - 11, 'text-anchor': 'end', class: 'viz-annotation'
        }, { fill: 'var(--viz-ink2)' });
        label.textContent = format(lastPoint.value);
        root.append(label);
      }
    }

    const hitWidth = Math.max(step, HIT_MIN / 2);
    points.forEach(function (point, index) {
      const hit = svg('rect', {
        x: xOf(index) - hitWidth / 2, y: area.top, width: hitWidth, height: area.height,
        fill: 'transparent', tabindex: '0', role: 'img',
        'aria-label': point.label + ': ' + (point.value === null ? 'no data' : format(point.value))
      }, { cursor: 'pointer', outline: 'none' });
      bindReadout(hit, point.label, [
        { value: point.value === null ? '-' : format(point.value), label: spec.valueLabel || '', color: 'var(--viz-s1)' }
      ].concat(point.detail ? [{ value: point.detail, label: point.detailLabel || '' }] : []));
      hit.addEventListener('pointerenter', function () { crosshair.setAttribute('x1', String(xOf(index))); crosshair.setAttribute('x2', String(xOf(index))); crosshair.style.opacity = '1'; });
      hit.addEventListener('focus', function () { crosshair.setAttribute('x1', String(xOf(index))); crosshair.setAttribute('x2', String(xOf(index))); crosshair.style.opacity = '1'; });
      hit.addEventListener('pointerleave', function () { crosshair.style.opacity = '0'; });
      hit.addEventListener('blur', function () { crosshair.style.opacity = '0'; });
      root.append(hit);
    });

    const crosshair = svg('line', {
      x1: area.left, x2: area.left, y1: area.top, y2: area.top + area.height, 'stroke-width': 1
    }, { stroke: 'var(--viz-axis)', opacity: '0', pointerEvents: 'none' });
    root.append(crosshair);

    const stride = labelStride(points.length, step, 34);
    points.forEach(function (point, index) {
      if (index % stride !== 0 && index !== points.length - 1) return;
      if (index !== points.length - 1 && points.length - 1 - index < stride * 0.6) return;
      const label = svg('text', {
        x: xOf(index), y: area.top + area.height + 15,
        'text-anchor': index === 0 ? 'start' : (index === points.length - 1 ? 'end' : 'middle'),
        class: 'viz-tick'
      }, { fill: 'var(--viz-muted)' });
      label.textContent = point.short;
      root.append(label);
    });

    this.plot.replaceChildren(root);
    this.setLegend(null);
    this.tableWrap.replaceChildren(buildTable(
      ['Week', spec.valueHeading || 'Value'],
      points.map(function (point) {
        return [point.label, point.value === null ? '-' : format(point.value)];
      })
    ));
  };

  /* ---------------------------------------------------------
     Sparkline - the stat-tile trend, not a chart card
     --------------------------------------------------------- */
  function sparkline(host, values, accentLast) {
    host.replaceChildren();
    if (!values || values.length < 2) return;
    const width = 72;
    const height = 20;
    const max = Math.max.apply(null, values);
    const min = Math.min.apply(null, values);
    const span = max - min || 1;

    const root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true'
    });
    const step = width / (values.length - 1);
    const points = values.map(function (value, index) {
      return [index * step, height - 2 - ((value - min) / span) * (height - 4)];
    });
    root.append(svg('path', {
      d: linePath(points), fill: 'none', 'stroke-width': 1.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }, { stroke: 'var(--viz-muted)', opacity: '0.55' }));

    if (accentLast !== false) {
      const last = points[points.length - 1];
      root.append(svg('circle', { cx: last[0], cy: last[1], r: 2.5 }, { fill: 'var(--viz-s1)' }));
    }
    host.append(root);
  }

  global.FocuslineCharts = {
    Chart: Chart,
    refreshAll: refreshAll,
    sparkline: sparkline,
    formatMinutes: formatMinutes,
    formatCompact: formatCompact,
    hideTip: hideTip
  };
})(window);
