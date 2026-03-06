/* global d3 */
/* Shared org chart renderer — used by firma.pug and organigramm.pug */
(function () {
  'use strict';

  function renderOrgChart(container, fnr, opts) {
    opts = opts || {};
    var fullscreen = !!opts.fullscreen;
    var THRESHOLD = fullscreen ? 200 : 80;

    container.innerHTML = '<p class="org-loading">Lade Organigramm\u2026</p>';

    fetch('/api/firma/' + encodeURIComponent(fnr) + '/baum')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (opts.onData) opts.onData(data);
        var total = countTree(data) + (data.tochter || []).length;
        container.innerHTML = '';
        if (total >= THRESHOLD) {
          renderTabular(data, container, fnr);
        } else {
          renderD3(data, container, fnr, fullscreen);
        }
      })
      .catch(function () {
        container.innerHTML = '<p class="org-error">Organigramm konnte nicht geladen werden.</p>';
      });
  }

  function countTree(node) {
    var c = 1;
    (node.children || []).forEach(function (ch) { c += countTree(ch); });
    return c;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Tabular fallback ────────────────────────────────────────────────
  function renderTabular(data, container, currentFnr) {
    var html = '<div class="org-table">';

    function addNode(node, depth) {
      var isRoot = (depth === 0);
      var nameHtml = node.fnr && !isRoot
        ? '<a href="/firma/' + node.fnr + '">' + escHtml(node.name) + '</a>'
        : '<strong>' + escHtml(node.name) + '</strong>';
      var typeLabel = node.type === 'person'
        ? ' <span class="org-table__type">Person</span>'
        : '';
      html += '<div class="org-table__row" style="--depth:' + depth + '">';
      html += '<span class="org-table__name">' + nameHtml + typeLabel + '</span>';
      if (node.fnr && !isRoot) {
        html += '<span class="org-table__fnr">' + escHtml(node.fnr) + '</span>';
      }
      html += '</div>';
      (node.children || []).forEach(function (c) { addNode(c, depth + 1); });
    }

    addNode(data, 0);

    var tochter = data.tochter || [];
    if (tochter.length > 0) {
      html += '<div class="org-table__section">Tochtergesellschaften (' + tochter.length + ')</div>';
      tochter.forEach(function (t) {
        html += '<div class="org-table__row" style="--depth:1">';
        html += '<span class="org-table__name"><a href="/firma/' + t.fnr + '">' + escHtml(t.name) + '</a></span>';
        html += '<span class="org-table__fnr">' + escHtml(t.fnr) + '</span>';
        html += '</div>';
      });
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // ── D3 collapsible tree ─────────────────────────────────────────────
  function renderD3(data, container, fnr, fullscreen) {
    var PAD = 16;
    var STD_W = 180, NODE_H = 44, MIN_W = 90;
    var H_GAP = 24, V_GAP = 70;

    var root = d3.hierarchy(data);

    // Collapse all nodes beyond depth 1 on first load (not for fullscreen)
    if (!fullscreen) {
      root.each(function (d) {
        if (d.depth > 1 && d.children) {
          d._children = d.children;
          d.children = null;
        }
      });
    }

    // Persistent overlay elements (created once, survive SVG redraws)
    var tooltip = d3.select(container).append('div').attr('class', 'org-tooltip');
    var zoomHint = d3.select(container).append('div').attr('class', 'org-zoom-hint')
      .text('Strg\u202f+\u202fScrollen zum Zoomen');
    var hintTimer;
    container.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) {
        zoomHint.classed('org-zoom-hint--visible', true);
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () {
          zoomHint.classed('org-zoom-hint--visible', false);
        }, 1500);
      }
    }, { passive: true });

    function attachHover(sel, gf, vs) {
      if (!((gf && gf.length) || (vs && vs.length))) return;
      sel
        .on('mouseover', function (event) {
          var parts = [];
          if (gf && gf.length) parts.push('<strong>Gesch\u00e4ftsf\u00fchrung</strong><br>' + gf.join('<br>'));
          if (vs && vs.length) parts.push('<strong>Vorstand</strong><br>' + vs.join('<br>'));
          tooltip.html(parts.join('<br><br>')).classed('org-tooltip--visible', true);
        })
        .on('mousemove', function (event) {
          var rect = container.getBoundingClientRect();
          tooltip
            .style('left', (event.clientX - rect.left + 14) + 'px')
            .style('top',  (event.clientY - rect.top  - 10) + 'px');
        })
        .on('mouseout', function () { tooltip.classed('org-tooltip--visible', false); });
    }

    function toggle(d) {
      if (d._children) {
        d.children = d._children;
        d._children = null;
      } else if (d.children) {
        d._children = d.children;
        d.children = null;
      }
      draw();
    }

    // ── draw() — called on initial render and after every toggle ──────
    function draw() {
      // Keep tooltip + zoom hint, replace only SVG(s)
      d3.select(container).selectAll('svg').remove();

      var containerW = container.clientWidth - 16;
      var levelCounts = {};
      root.each(function (d) {
        levelCounts[d.depth] = (levelCounts[d.depth] || 0) + 1;
      });
      var maxBreadth = Math.max.apply(null,
        Object.keys(levelCounts).map(function (k) { return +levelCounts[k]; }));

      var nodeW = STD_W;
      var stacked = false;
      var neededW = maxBreadth * (STD_W + H_GAP) - H_GAP;
      if (neededW > containerW) {
        nodeW = Math.floor((containerW + H_GAP) / maxBreadth) - H_GAP;
        if (nodeW < MIN_W) { nodeW = STD_W; stacked = true; }
      }
      var maxChars = Math.max(8, Math.floor(nodeW / 7.5));

      if (!stacked) {
        drawNormal(nodeW, maxChars);
      } else {
        drawStacked(maxChars);
      }
    }

    // ── Normal layout: root at bottom, shareholders fan upward ────────
    function drawNormal(nodeW, maxChars) {
      d3.tree().nodeSize([nodeW + H_GAP, NODE_H + V_GAP])(root);
      root.each(function (d) { d.y = -d.y; });

      var nodes = root.descendants();
      var xs = nodes.map(function (d) { return d.x; });
      var ys = nodes.map(function (d) { return d.y; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      var containerW = container.clientWidth - 16;

      var svgW = Math.max(maxX - minX + nodeW + PAD * 2, containerW);
      var treeH = maxY - minY + NODE_H + PAD * 2;
      var svgH  = Math.max(treeH, container.clientHeight);
      var offsetX = -minX + (svgW - (maxX - minX + nodeW)) / 2;
      var offsetY = -minY + (svgH - (maxY - minY + NODE_H)) / 2 + NODE_H / 2;

      var svg = d3.select(container).append('svg').attr('width', svgW).attr('height', svgH);
      var zoomG = svg.append('g');
      var g = zoomG.append('g').attr('transform', 'translate(' + offsetX + ',' + offsetY + ')');

      g.selectAll('.org-link').data(root.links()).join('path').attr('class', 'org-link')
        .attr('d', d3.linkVertical()
          .x(function (n) { return n.x; })
          .y(function (n) { return n.y; }));

      drawNodes(g, nodes, function (d) { return d.x; }, function (d) { return d.y; }, nodeW, maxChars);

      // ── Extra nodes: Töchter (below root) + co-owners + sisters ────
      var extraLink = d3.linkVertical().x(function (n) { return n.x; }).y(function (n) { return n.y; });
      var rendered = new Set();
      nodes.forEach(function (d) { if (d.data.fnr) rendered.add(d.data.fnr); });

      var tochter = (data.tochter || []).filter(function (t) { return t.fnr && !rendered.has(t.fnr); });
      var tochterY = 0;
      var GROUP_THRESHOLD = 6;
      var useGrouped = tochter.length >= GROUP_THRESHOLD;

      if (tochter.length > 0 && !useGrouped) {
        // ── Flat layout (few Töchter) ───────────────────────────────────
        tochterY = NODE_H + V_GAP;
        svg.attr('height', +svg.attr('height') + V_GAP + NODE_H);
        var totalSubW = tochter.length * (nodeW + H_GAP) - H_GAP;
        var subStartX = root.x - totalSubW / 2;
        tochter.forEach(function (t, i) {
          rendered.add(t.fnr);
          var tx = subStartX + i * (nodeW + H_GAP) + nodeW / 2;
          g.append('path').attr('class', 'org-link')
            .attr('d', extraLink({ source: { x: root.x, y: NODE_H / 2 }, target: { x: tx, y: tochterY - NODE_H / 2 } }));
          var nG = g.append('g').attr('class', 'org-node org-node--firma')
            .attr('transform', 'translate(' + tx + ',' + tochterY + ')');
          nG.style('cursor', 'pointer').on('click', function () { window.location = '/firma/' + t.fnr; });
          nG.append('rect').attr('x', -nodeW / 2).attr('y', -NODE_H / 2).attr('width', nodeW).attr('height', NODE_H).attr('rx', 6);
          nG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
            .text(t.name.length > maxChars ? t.name.slice(0, maxChars - 1) + '\u2026' : t.name);
          attachHover(nG, t.geschaeftsfuehrer, t.vorstand);
        });
      }

      var treeMaxX = Math.max.apply(null, nodes.map(function (d) { return d.x; })) + nodeW / 2;
      var nextExtraX = treeMaxX + H_GAP;
      var maxExtraX = treeMaxX;

      if (!useGrouped) {
        // ── Co-owners (flat layout) ─────────────────────────────────────
        var coSubW = tochter.length * (nodeW + H_GAP) - H_GAP;
        var coSubSX = root.x - coSubW / 2;
        tochter.forEach(function (t, i) {
          var tochterNodeX = coSubSX + i * (nodeW + H_GAP) + nodeW / 2;
          (t.coGesellschafter || []).forEach(function (cg) {
            if (rendered.has(cg.fnr)) return;
            rendered.add(cg.fnr);
            var cgx = nextExtraX + nodeW / 2;
            nextExtraX += nodeW + H_GAP;
            maxExtraX = Math.max(maxExtraX, cgx + nodeW / 2);
            g.append('path').attr('class', 'org-link')
              .attr('d', extraLink({ source: { x: cgx, y: NODE_H / 2 }, target: { x: tochterNodeX, y: tochterY - NODE_H / 2 } }));
            var cgG = g.append('g').attr('class', 'org-node org-node--firma')
              .attr('transform', 'translate(' + cgx + ',0)');
            cgG.style('cursor', 'pointer').on('click', function () { window.location = '/firma/' + cg.fnr; });
            cgG.append('rect').attr('x', -nodeW / 2).attr('y', -NODE_H / 2).attr('width', nodeW).attr('height', NODE_H).attr('rx', 6);
            cgG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
              .text(cg.name.length > maxChars ? cg.name.slice(0, maxChars - 1) + '\u2026' : cg.name);
            attachHover(cgG, cg.geschaeftsfuehrer, cg.vorstand);
          });
        });
      } else if (tochter.length > 0) {
        // ── Grouped layout (many Töchter) ───────────────────────────────
        // Group by co-Gesellschafter fingerprint (sorted FNR list)
        var groupMap = {};
        tochter.forEach(function (t) {
          var coges = (t.coGesellschafter || []).slice()
            .sort(function (a, b) { return a.fnr < b.fnr ? -1 : 1; });
          var gKey = coges.map(function (c) { return c.fnr; }).join('|') || '__allein__';
          if (!groupMap[gKey]) groupMap[gKey] = { coges: coges, items: [] };
          groupMap[gKey].items.push(t);
        });
        var groups = Object.keys(groupMap).map(function (k) { return groupMap[k]; })
          .sort(function (a, b) { return b.items.length - a.items.length; });

        var ITEM_V_GAP2 = 8;
        var GROUP_H_PAD = H_GAP * 2;
        var HUB_Y2 = NODE_H / 2 + 24;
        // CoGes is shown as a text label only (not a node) — label Y sits between hub and first item
        var COGES_LABEL_Y = HUB_Y2 + 14;
        var FIRST_ITEM_Y2 = HUB_Y2 + 32 + NODE_H / 2;

        var totalGroupsW = groups.length * nodeW + (groups.length - 1) * GROUP_H_PAD;
        var grpStartX = root.x - totalGroupsW / 2 + nodeW / 2;
        var hubLeft = grpStartX;
        var hubRight = grpStartX + (groups.length - 1) * (nodeW + GROUP_H_PAD);
        var maxItems = Math.max.apply(null, groups.map(function (grp) { return grp.items.length; }));

        // Hub: vertical stem from root + horizontal bar across groups
        g.append('path').attr('class', 'org-link')
          .attr('d', 'M' + root.x + ',' + (NODE_H / 2) + 'L' + root.x + ',' + HUB_Y2);
        if (groups.length > 1) {
          g.append('path').attr('class', 'org-link')
            .attr('d', 'M' + hubLeft + ',' + HUB_Y2 + 'L' + hubRight + ',' + HUB_Y2);
        }

        groups.forEach(function (grp, gi) {
          var cx = grpStartX + gi * (nodeW + GROUP_H_PAD);

          // Drop from hub directly to first item (co-owner is NOT in the vertical chain)
          g.append('path').attr('class', 'org-link')
            .attr('d', 'M' + cx + ',' + HUB_Y2 + 'L' + cx + ',' + (FIRST_ITEM_Y2 - NODE_H / 2));

          // Co-Gesellschafter: text label only (avoids visual confusion with parent-child hierarchy)
          var cg = (grp.coges || []).filter(function (c) { return !rendered.has(c.fnr); })[0]
                || (grp.coges || [])[0];
          if (cg) {
            if (!rendered.has(cg.fnr)) rendered.add(cg.fnr);
            var labelName = 'Co: ' + (cg.name.length > maxChars - 4
              ? cg.name.slice(0, maxChars - 5) + '\u2026' : cg.name);
            var cgLbl = g.append('g').attr('class', 'org-coges-label')
              .attr('transform', 'translate(' + cx + ',' + COGES_LABEL_Y + ')')
              .style('cursor', 'pointer')
              .on('click', (function (f) { return function () { window.location = '/firma/' + f; }; })(cg.fnr));
            cgLbl.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
              .text(labelName);
          }

          // Vertical bar connecting all items in column
          if (grp.items.length > 1) {
            var lastItemY = FIRST_ITEM_Y2 + (grp.items.length - 1) * (NODE_H + ITEM_V_GAP2);
            g.append('path').attr('class', 'org-link')
              .attr('d', 'M' + cx + ',' + (FIRST_ITEM_Y2 - NODE_H / 2) + 'L' + cx + ',' + (lastItemY + NODE_H / 2));
          }

          // Stacked item nodes
          grp.items.forEach(function (t, ti) {
            rendered.add(t.fnr);
            var ty = FIRST_ITEM_Y2 + ti * (NODE_H + ITEM_V_GAP2);
            var nG = g.append('g').attr('class', 'org-node org-node--firma')
              .attr('transform', 'translate(' + cx + ',' + ty + ')');
            nG.style('cursor', 'pointer').on('click', (function (f) {
              return function () { window.location = '/firma/' + f; };
            })(t.fnr));
            nG.append('rect').attr('x', -nodeW / 2).attr('y', -NODE_H / 2).attr('width', nodeW).attr('height', NODE_H).attr('rx', 6);
            nG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
              .text(t.name.length > maxChars ? t.name.slice(0, maxChars - 1) + '\u2026' : t.name);
            attachHover(nG, t.geschaeftsfuehrer, t.vorstand);
          });

          maxExtraX = Math.max(maxExtraX, cx + nodeW / 2);
        });

        // Sisters will be drawn to the right of all groups
        nextExtraX = hubRight + nodeW / 2 + H_GAP;

        // Extend SVG height for grouped section
        var groupBottomSvg = offsetY + FIRST_ITEM_Y2 + (maxItems - 1) * (NODE_H + ITEM_V_GAP2) + NODE_H / 2 + PAD;
        if (groupBottomSvg > +svg.attr('height')) {
          svg.attr('height', groupBottomSvg);
        }

        // Extend SVG width if groups exceed right edge
        var groupRightSvg = offsetX + hubRight + nodeW / 2 + PAD;
        if (groupRightSvg > +svg.attr('width')) {
          svg.attr('width', groupRightSvg);
        }
      }

      // ── Sisters (subsidiaries of non-root tree nodes) ───────────────
      nodes.filter(function (d) { return d.depth > 0 && d.data.type === 'firma'; })
        .forEach(function (d) {
          (d.data.tochter || []).forEach(function (s) {
            if (!s.fnr || rendered.has(s.fnr)) return;
            rendered.add(s.fnr);
            var sibY = d.y + NODE_H + V_GAP;
            var sx = nextExtraX + nodeW / 2;
            nextExtraX += nodeW + H_GAP;
            maxExtraX = Math.max(maxExtraX, sx + nodeW / 2);
            g.append('path').attr('class', 'org-link')
              .attr('d', extraLink({ source: { x: d.x, y: d.y + NODE_H / 2 }, target: { x: sx, y: sibY - NODE_H / 2 } }));
            var nG = g.append('g').attr('class', 'org-node org-node--firma')
              .attr('transform', 'translate(' + sx + ',' + sibY + ')');
            nG.style('cursor', 'pointer').on('click', function () { window.location = '/firma/' + s.fnr; });
            nG.append('rect').attr('x', -nodeW / 2).attr('y', -NODE_H / 2).attr('width', nodeW).attr('height', NODE_H).attr('rx', 6);
            nG.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
              .text(s.name.length > maxChars ? s.name.slice(0, maxChars - 1) + '\u2026' : s.name);
            attachHover(nG, s.geschaeftsfuehrer, s.vorstand);
          });
        });

      if (maxExtraX + offsetX + PAD > +svg.attr('width')) {
        svg.attr('width', maxExtraX + offsetX + PAD);
      }

      svg.call(d3.zoom()
        .filter(function (event) { return event.type === 'wheel' ? event.ctrlKey : true; })
        .scaleExtent([0.25, 4])
        .on('zoom', function (event) { zoomG.attr('transform', event.transform); }));
    }

    // ── Stacked layout: root on right, shareholders stacked left ──────
    function drawStacked(maxChars) {
      var LEVEL_W = STD_W + H_GAP;
      var ROW_H   = NODE_H + 28;
      var containerW = container.clientWidth - 16;

      d3.tree().nodeSize([ROW_H, LEVEL_W])(root);

      var nodes = root.descendants();
      var xs = nodes.map(function (d) { return d.x; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var treeH = maxX - minX + NODE_H + PAD * 2;
      var svgH  = Math.max(treeH, container.clientHeight);
      var svgW  = Math.max((root.height + 1) * LEVEL_W + PAD * 2, containerW);
      var rightEdge = svgW - PAD;
      var extraPadY = (svgH - treeH) / 2;

      function gx(d) { return rightEdge - d.y - STD_W / 2; }
      function gy(d) { return d.x - minX + PAD + NODE_H / 2 + extraPadY; }

      var svg = d3.select(container).append('svg').attr('width', svgW).attr('height', svgH);
      var zoomG = svg.append('g');
      var g = zoomG.append('g');

      g.selectAll('.org-link').data(root.links()).join('path').attr('class', 'org-link')
        .attr('d', d3.linkHorizontal()
          .x(function (n) { return gx(n); })
          .y(function (n) { return gy(n); }));

      drawNodes(g, nodes, gx, gy, STD_W, maxChars);

      svg.call(d3.zoom()
        .filter(function (event) { return event.type === 'wheel' ? event.ctrlKey : true; })
        .scaleExtent([0.25, 4])
        .on('zoom', function (event) { zoomG.attr('transform', event.transform); }));
    }

    // ── drawNodes — shared by normal + stacked layouts ─────────────────
    function drawNodes(g, nodes, getX, getY, nW, maxChars) {
      var node = g.selectAll('.org-node')
        .data(nodes).join('g')
        .attr('class', function (d) {
          var cls = 'org-node org-node--' + d.data.type;
          if (d.data.fnr === fnr) cls += ' org-node--current';
          return cls;
        })
        .attr('transform', function (d) {
          return 'translate(' + getX(d) + ',' + getY(d) + ')';
        });

      node.append('rect')
        .attr('x', -nW / 2).attr('y', -NODE_H / 2)
        .attr('width', nW).attr('height', NODE_H).attr('rx', 6);

      node.append('text')
        .attr('text-anchor', 'middle').attr('dy', '0.35em')
        .text(function (d) {
          var n = d.data.name;
          return n.length > maxChars ? n.slice(0, maxChars - 1) + '\u2026' : n;
        });

      // Expand/collapse indicator: non-root nodes that have children (visible or hidden)
      var toggleable = node.filter(function (d) {
        return d.depth > 0 && (d._children || (d.children && d.children.length > 0));
      });
      toggleable.append('circle')
        .attr('class', 'org-expand-btn')
        .attr('cx', 0).attr('cy', -NODE_H / 2).attr('r', 9)
        .style('cursor', 'pointer')
        .on('click', function (event, d) {
          event.stopPropagation();
          toggle(d);
        });
      toggleable.append('text')
        .attr('class', 'org-expand-label')
        .attr('text-anchor', 'middle')
        .attr('x', 0).attr('y', -NODE_H / 2 + 5)
        .style('pointer-events', 'none')
        .text(function (d) { return d._children ? '+' : '\u2212'; });

      // Hover: Geschäftsführer / Vorstand tooltip
      node.filter(function (d) {
        return d.data.type === 'firma' && (
          (d.data.geschaeftsfuehrer && d.data.geschaeftsfuehrer.length > 0) ||
          (d.data.vorstand && d.data.vorstand.length > 0));
      }).each(function (d) {
        attachHover(d3.select(this), d.data.geschaeftsfuehrer, d.data.vorstand);
      });

      // Click: navigate to company page (expand btn uses stopPropagation to take priority)
      node.filter(function (d) {
        return d.data.type === 'firma' && d.data.fnr && d.data.fnr !== fnr;
      })
        .style('cursor', 'pointer')
        .on('click', function (event, d) { window.location = '/firma/' + d.data.fnr; });
    }

    draw(); // initial render
  }

  window.renderOrgChart = renderOrgChart;
})();
