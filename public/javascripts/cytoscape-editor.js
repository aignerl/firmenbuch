'use strict';
/* global cytoscape */

(function () {
  var cy;
  var rootFnr = '';
  var drawMode = false;
  var drawSource = null;

  // ── Utilities ────────────────────────────────────────────────

  function generateId() {
    return 'manual:' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function downloadJson(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Styles ───────────────────────────────────────────────────

  function buildStyles() {
    return [
      {
        selector: 'node[type="firma"][source="soap"]',
        style: {
          shape: 'roundrectangle',
          'background-color': '#1a73e8',
          color: '#fff',
          label: 'data(name)',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'font-size': '11px',
          'font-family': 'Roboto, sans-serif',
          'padding-top': '8px',
          'padding-bottom': '8px',
          'padding-left': '10px',
          'padding-right': '10px',
          width: 'label',
          height: 'label',
          'border-width': 0,
        }
      },
      {
        selector: 'node[?isRoot]',
        style: {
          'background-color': '#1557b0',
          'border-width': 3,
          'border-color': '#fbbc04',
          'font-weight': '700',
        }
      },
      {
        selector: 'node[type="firma"][source="manual"]',
        style: {
          shape: 'roundrectangle',
          'background-color': '#f8f9fa',
          color: '#202124',
          label: 'data(name)',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'font-size': '11px',
          'font-family': 'Roboto, sans-serif',
          'padding-top': '8px',
          'padding-bottom': '8px',
          'padding-left': '10px',
          'padding-right': '10px',
          width: 'label',
          height: 'label',
          'border-width': 2,
          'border-style': 'dashed',
          'border-color': '#5f6368',
        }
      },
      {
        selector: 'node[type="person"]',
        style: {
          shape: 'ellipse',
          'background-color': '#34a853',
          color: '#fff',
          label: 'data(name)',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '120px',
          'font-size': '10px',
          'font-family': 'Roboto, sans-serif',
          'padding-top': '8px',
          'padding-bottom': '8px',
          'padding-left': '10px',
          'padding-right': '10px',
          width: 'label',
          height: 'label',
        }
      },
      {
        selector: 'edge[edgeSource="soap"]',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          width: 2,
          'line-color': '#5f6368',
          'target-arrow-color': '#5f6368',
          label: 'data(prozentLabel)',
          'font-size': '10px',
          'text-background-color': '#fff',
          'text-background-opacity': 1,
          'text-background-padding': '2px',
        }
      },
      {
        selector: 'edge[edgeSource="manual"]',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          width: 2,
          'line-color': '#1a73e8',
          'target-arrow-color': '#1a73e8',
          'line-style': 'dashed',
          label: 'data(prozentLabel)',
          'font-size': '10px',
          'text-background-color': '#fff',
          'text-background-opacity': 1,
          'text-background-padding': '2px',
        }
      },
      {
        selector: ':selected',
        style: {
          'overlay-color': '#fbbc04',
          'overlay-opacity': 0.15,
          'border-color': '#fbbc04',
          'border-width': 3,
          'line-color': '#fbbc04',
          'target-arrow-color': '#fbbc04',
        }
      },
      {
        selector: 'node.personengesellschaft',
        style: {
          shape: 'triangle',
          'background-color': '#f9ab00',
          color: '#fff',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '8px',
        }
      },
      {
        selector: '.draw-source',
        style: {
          'border-width': 3,
          'border-color': '#1a73e8',
          'overlay-color': '#1a73e8',
          'overlay-opacity': 0.12,
        }
      },
    ];
  }

  // ── Personengesellschaft ─────────────────────────────────────

  function checkPersonengesellschaft(node) {
    var rf = (node.data('rechtsform') || '').toUpperCase();
    var is = /\bOG\b|\bKG\b|GESBR|GESNBR|EWIV/.test(rf);
    if (is) node.addClass('personengesellschaft');
    else node.removeClass('personengesellschaft');
  }

  // ── Draw-Edge Mode ───────────────────────────────────────────

  function setDrawMode(on) {
    drawMode = on;
    var btn = document.getElementById('btn-draw-edge');
    if (on) {
      btn.classList.add('editor-btn--active');
      document.getElementById('cy').style.cursor = 'crosshair';
    } else {
      btn.classList.remove('editor-btn--active');
      document.getElementById('cy').style.cursor = '';
      cancelDrawSource();
    }
  }

  function cancelDrawSource() {
    if (drawSource) {
      drawSource.removeClass('draw-source');
      drawSource = null;
    }
  }

  function handleDrawTap(node) {
    if (!drawSource) {
      drawSource = node;
      node.addClass('draw-source');
    } else if (drawSource.same(node)) {
      cancelDrawSource();
    } else {
      var src = drawSource;
      cancelDrawSource();
      var edge = cy.add({
        group: 'edges',
        data: {
          id: 'e:' + src.id() + ':' + node.id() + ':' + Date.now(),
          source: src.id(),
          target: node.id(),
          prozent: null,
          prozentLabel: '',
          edgeSource: 'manual',
          typ: 'direkt',
        }
      });
      setDrawMode(false);
      cy.elements().unselect();
      edge.select();
      showPropsPanel(edge);
    }
  }

  // ── Properties Panel ─────────────────────────────────────────

  function showPropsPanel(ele) {
    var panel = document.getElementById('props-panel');
    var nodeForm = document.getElementById('props-node-form');
    var edgeForm = document.getElementById('props-edge-form');
    var title = document.getElementById('props-title');
    panel.hidden = false;

    if (ele.isNode()) {
      var isManual = ele.data('source') === 'manual';
      title.textContent = 'Knoten bearbeiten';
      nodeForm.hidden = false;
      edgeForm.hidden = true;
      document.getElementById('pn-name').value = ele.data('name') || '';
      document.getElementById('pn-name').readOnly = false;
      document.getElementById('pn-fnr').value = ele.data('fnr') || '';
      document.getElementById('pn-fnr').readOnly = false;
      document.getElementById('pn-land').value = ele.data('land') || '';
      document.getElementById('pn-land').readOnly = false;
      document.getElementById('pn-rechtsform').value = ele.data('rechtsform') || '';
      document.getElementById('pn-rechtsform').readOnly = false;
      document.getElementById('pn-note').value = ele.data('note') || '';
      document.getElementById('pn-note').readOnly = false;
      document.getElementById('props-node-delete-btn').style.display = isManual ? '' : 'none';
      document.getElementById('props-node-save-btn').style.display = '';
      document.getElementById('props-node-delete-btn').onclick = function () { ele.remove(); hidePropsPanel(); };
      document.getElementById('props-node-save-btn').onclick = function () {
        var v = document.getElementById('pn-name').value.trim();
        if (v) ele.data('name', v);
        ele.data('fnr', document.getElementById('pn-fnr').value.trim() || null);
        ele.data('land', document.getElementById('pn-land').value.trim() || null);
        ele.data('rechtsform', document.getElementById('pn-rechtsform').value.trim() || null);
        ele.data('note', document.getElementById('pn-note').value.trim() || null);
        checkPersonengesellschaft(ele);
      };

    } else if (ele.isEdge()) {
      var isManualEdge = ele.data('edgeSource') === 'manual';
      title.textContent = 'Kante bearbeiten';
      nodeForm.hidden = true;
      edgeForm.hidden = false;
      var prozent = ele.data('prozent');
      document.getElementById('pe-prozent').value = prozent != null ? prozent : '';
      document.getElementById('pe-prozent').readOnly = false;
      document.getElementById('pe-typ').value = ele.data('typ') || 'direkt';
      document.getElementById('pe-typ').disabled = false;
      document.getElementById('props-edge-delete-btn').style.display = isManualEdge ? '' : 'none';
      document.getElementById('props-edge-save-btn').style.display = '';
      document.getElementById('props-edge-delete-btn').onclick = function () { ele.remove(); hidePropsPanel(); };
      document.getElementById('props-edge-save-btn').onclick = function () {
        var p = parseFloat(document.getElementById('pe-prozent').value);
        ele.data('prozent', isNaN(p) ? null : p);
        ele.data('typ', document.getElementById('pe-typ').value);
        updateEdgeLabel(ele);
      };
    }
  }

  function hidePropsPanel() {
    document.getElementById('props-panel').hidden = true;
  }

  function updateEdgeLabel(edge) {
    var p = edge.data('prozent');
    edge.data('prozentLabel', p != null ? p + '%' : '');
  }

  // ── Selection ────────────────────────────────────────────────

  function initSelection() {
    cy.on('tap', 'node', function (evt) {
      if (drawMode) {
        handleDrawTap(evt.target);
      } else {
        showPropsPanel(evt.target);
      }
    });

    cy.on('tap', 'edge', function (evt) {
      if (!drawMode) showPropsPanel(evt.target);
    });

    cy.on('tap', function (evt) {
      if (evt.target !== cy) return;
      if (drawMode) {
        cancelDrawSource();
      } else {
        hidePropsPanel();
        cy.elements().unselect();
      }
    });
  }

  // ── Add Node Modal ───────────────────────────────────────────

  function updateAddNodeModalFields() {
    var typ = document.getElementById('an-typ').value;
    var firmaFields = document.querySelectorAll('.an-firma-field');
    firmaFields.forEach(function (f) { f.hidden = typ === 'person'; });
  }

  function openAddNodeModal() {
    var overlay = document.getElementById('modal-overlay');
    overlay.hidden = false;
    document.getElementById('an-typ').value = 'firma';
    document.getElementById('an-name').value = '';
    document.getElementById('an-fnr').value = '';
    document.getElementById('an-land').value = '';
    document.getElementById('an-rechtsform').value = '';
    document.getElementById('an-note').value = '';
    updateAddNodeModalFields();
    setTimeout(function () { document.getElementById('an-name').focus(); }, 50);
  }

  function closeAddNodeModal() {
    document.getElementById('modal-overlay').hidden = true;
  }

  function submitAddNode() {
    var name = document.getElementById('an-name').value.trim();
    if (!name) { document.getElementById('an-name').focus(); return; }
    var typ = document.getElementById('an-typ').value;
    var ext = cy.extent();
    var rechtsform = typ === 'firma' ? (document.getElementById('an-rechtsform').value.trim() || null) : null;
    var node = cy.add({
      group: 'nodes',
      data: {
        id: generateId(),
        name: name,
        fnr: typ === 'firma' ? (document.getElementById('an-fnr').value.trim() || null) : null,
        type: typ,
        land: typ === 'firma' ? (document.getElementById('an-land').value.trim() || null) : null,
        rechtsform: rechtsform,
        note: document.getElementById('an-note').value.trim() || null,
        source: 'manual',
      },
      position: { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 },
    });
    checkPersonengesellschaft(node);
    closeAddNodeModal();
  }

  // ── Export ───────────────────────────────────────────────────

  function exportDiagram() {
    var pos = {};
    cy.nodes().forEach(function (n) { pos[n.id()] = n.position(); });

    var exportNodes = [];
    cy.nodes('[source="manual"]').forEach(function (n) {
      exportNodes.push(Object.assign({}, n.data(), { x: pos[n.id()].x, y: pos[n.id()].y }));
    });
    cy.nodes('[source="soap"]').forEach(function (n) {
      exportNodes.push({ id: n.id(), source: 'soap', x: pos[n.id()].x, y: pos[n.id()].y });
    });

    var exportEdges = [];
    cy.edges('[edgeSource="manual"]').forEach(function (e) {
      exportEdges.push(Object.assign({}, e.data()));
    });

    downloadJson({
      version: 1,
      rootFnr: rootFnr,
      exportedAt: new Date().toISOString(),
      nodes: exportNodes,
      edges: exportEdges,
    }, 'organigramm-' + rootFnr + '.json');
  }

  // ── Import ───────────────────────────────────────────────────

  function importDiagram(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var json = JSON.parse(e.target.result);
        (json.nodes || []).filter(function (n) { return n.source === 'manual'; }).forEach(function (n) {
          if (cy.getElementById(n.id).length === 0) {
            cy.add({ group: 'nodes', data: Object.assign({}, n), position: { x: n.x || 0, y: n.y || 0 } });
          }
        });
        (json.edges || []).filter(function (ev) { return ev.edgeSource === 'manual'; }).forEach(function (ev) {
          if (cy.getElementById(ev.id).length === 0) {
            cy.add({ group: 'edges', data: Object.assign({}, ev) });
          }
        });
        (json.nodes || []).forEach(function (n) {
          var node = cy.getElementById(n.id);
          if (node.length && n.x != null && n.y != null) {
            node.position({ x: n.x, y: n.y });
          }
        });
        cy.edges().forEach(updateEdgeLabel);
      } catch (err) {
        alert('Fehler beim Laden: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ── Keyboard ─────────────────────────────────────────────────

  function initKeyboard() {
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        cy.$(':selected').filter('[source="manual"], [edgeSource="manual"]').remove();
        hidePropsPanel();
      }
      if (e.key === 'Escape') {
        if (drawMode) {
          setDrawMode(false);
        } else {
          closeAddNodeModal();
          hidePropsPanel();
          cy.elements().unselect();
        }
      }
    });
  }

  // ── Layout ───────────────────────────────────────────────────

  function runLayout(animate) {
    var anim = animate !== false;
    cy.layout({
      name: 'breadthfirst',
      directed: true,
      roots: cy.getElementById('fnr:' + rootFnr).length ? ['fnr:' + rootFnr] : undefined,
      padding: 40,
      spacingFactor: 1.75,
      animate: anim,
      animationDuration: 350,
    }).run().on('layoutstop', function () { cy.fit(undefined, 40); });
  }

  // ── Init ─────────────────────────────────────────────────────

  function init() {
    var el = document.getElementById('cy');
    if (!el) return;
    rootFnr = el.dataset.fnr;

    fetch('/api/firma/' + rootFnr + '/graph')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        data.edges.forEach(function (e) {
          e.data.prozentLabel = e.data.prozent != null ? e.data.prozent + '%' : '';
        });

        cy = cytoscape({
          container: el,
          elements: data.nodes.concat(data.edges),
          style: buildStyles(),
          layout: { name: 'preset' },
        });

        cy.nodes().forEach(checkPersonengesellschaft);
        runLayout(false);
        initSelection();
        initKeyboard();

        var rootNode = cy.getElementById('fnr:' + rootFnr);
        if (rootNode.length) {
          var nameEl = document.getElementById('editor-firma-name');
          if (nameEl) nameEl.textContent = rootNode.data('name');
          document.title = rootNode.data('name') + ' – Editor';
        }

        document.getElementById('an-typ').addEventListener('change', updateAddNodeModalFields);
        document.getElementById('btn-add-node').addEventListener('click', openAddNodeModal);
        document.getElementById('btn-draw-edge').addEventListener('click', function () {
          setDrawMode(!drawMode);
        });
        document.getElementById('btn-save').addEventListener('click', exportDiagram);
        document.getElementById('btn-layout').addEventListener('click', runLayout);

        var fileInput = document.getElementById('file-import');
        fileInput.addEventListener('change', function (e) {
          if (e.target.files[0]) {
            importDiagram(e.target.files[0]);
            e.target.value = '';
          }
        });

        document.getElementById('btn-modal-cancel').addEventListener('click', closeAddNodeModal);
        document.getElementById('btn-modal-add').addEventListener('click', submitAddNode);
        document.getElementById('modal-overlay').addEventListener('click', function (e) {
          if (e.target === this) closeAddNodeModal();
        });
        document.getElementById('modal-add-node').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') submitAddNode();
        });
        document.getElementById('props-close-btn').addEventListener('click', hidePropsPanel);

        var loading = document.getElementById('cy-loading');
        if (loading) loading.remove();
      })
      .catch(function (err) {
        var loading = document.getElementById('cy-loading');
        if (loading) loading.textContent = 'Fehler beim Laden: ' + err.message;
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
