/** Shared squad presentation and personal deployment countdown. */
(function(global){'use strict'; const VF=global.VF; Object.assign(VF.UI,{
    _deployGearSvg(kind) {
      const icons = {
        rifle:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 13h42l8-6h8l2 5h25v5H62l-8 4H35l-7 8h-9l5-9H3z"/><rect x="42" y="19" width="8" height="9" transform="skewX(-12)"/></svg>',
        pistol:
          '<svg viewBox="0 0 64 32" aria-hidden="true"><path d="M8 8h39l7 5v6H32l-3 11H18l2-13H8z"/><rect x="45" y="11" width="10" height="3"/></svg>',
        shotgun:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 13h59l18-5 12 3v5l-29 2H39l-8 10H20l5-11H3z"/><rect x="48" y="18" width="7" height="10" transform="skewX(-10)"/></svg>',
        rpg:
          '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M3 12h15l4-6h53l5 5 13 5-13 5-5 5H22l-4-6H3z"/><path d="M40 24l7 7h10l-5-7z"/></svg>',
        grenade:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 8h17l4 7v13l-5 6H17l-6-6V15z"/><path d="M20 3h11v6H20zM30 2h9v3h-9z"/></svg>',
        charge:
          '<svg viewBox="0 0 52 36" aria-hidden="true"><rect x="8" y="8" width="33" height="24" rx="2"/><path d="M17 8V3h17v5M18 17h13v4H18z" fill="none"/></svg>',
        turret:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><path d="M13 16h31l5 6-6 6H14L8 22z"/><rect x="25" y="8" width="10" height="9"/><path d="M34 10h20v3H34zM19 28l-6 7M39 28l6 7" fill="none"/></svg>',
        repair:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M12 3l8 8-4 5-8-8c-5 8 1 16 9 15l10 10 7-7-10-10c1-8-6-14-12-13z"/></svg>',
        medkit:
          '<svg viewBox="0 0 52 36" aria-hidden="true"><rect x="7" y="9" width="38" height="24" rx="2"/><path d="M21 3h10v7H21zM23 14h7v5h5v7h-5v5h-7v-5h-5v-7h5z"/></svg>',
        ammo:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><rect x="5" y="10" width="48" height="23" rx="2"/><path d="M16 10V6h26v4M17 17h5v11h-5zM27 17h5v11h-5zM37 17h5v11h-5z"/></svg>',
        binoculars:
          '<svg viewBox="0 0 58 36" aria-hidden="true"><path d="M8 11h15l4 7h4l4-7h15l5 18H34l-3-6h-4l-3 6H3z"/><circle cx="14" cy="25" r="7"/><circle cx="44" cy="25" r="7"/></svg>',
        cloak:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M24 3l16 7v10c0 8-7 13-16 15C15 33 8 28 8 20V10z"/><path d="M17 20l5 5 10-12" fill="none"/></svg>',
        knife:
          '<svg viewBox="0 0 68 30" aria-hidden="true"><path d="M4 19h17l4-5 36-10-8 12-27 7-5-3H4z"/><rect x="7" y="16" width="15" height="8"/></svg>',
        sledge:
          '<svg viewBox="0 0 68 32" aria-hidden="true"><path d="M8 18h22l3-8h24v16H33l-3-6H8z"/><rect x="6" y="16" width="18" height="8"/></svg>',
        frag:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 8h17l4 7v13l-5 6H17l-6-6V15z"/><path d="M20 3h11v6H20zM30 2h9v3h-9z"/></svg>',
        flash:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M17 10h14l4 6v12l-5 6H18l-6-6V16z"/><path d="M24 2l3 7h-6zM8 18h6M34 18h6M12 8l4 4M32 8l-4 4"/></svg>',
        smoke:
          '<svg viewBox="0 0 48 36" aria-hidden="true"><path d="M18 14h14l3 5v11l-4 5H19l-5-5V19z"/><path d="M16 8c4-6 14-6 18 0M12 12c5-4 16-4 22 0"/></svg>',
        optic:
          '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="6" y="12" width="22" height="8"/><circle cx="34" cy="16" r="8" fill="none"/><circle cx="34" cy="16" r="3"/></svg>',
        muzzle:
          '<svg viewBox="0 0 64 28" aria-hidden="true"><path d="M4 12h34l8-6h14v16H46l-8-6H4z"/></svg>',
      };
      return (
        icons[kind] ||
        '<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="7" y="7" width="34" height="20"/></svg>'
      );
    },

    _getPresentationRenderer() {
      if (this._presentationRenderer) return this._presentationRenderer;
      if (!global.THREE) return null;
      this._presentationRenderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      // Canvas dimensions are already DPR-scaled before setSize.
      this._presentationRenderer.setPixelRatio(1);
      this._presentationRenderer.setClearColor(0x000000, 0);
      return this._presentationRenderer;
    },

    openSquadIntro(roster, onComplete, opts) {
      opts = opts || {};
      if (!this.els.squadIntroOverlay) {
        if (typeof onComplete === 'function') onComplete();
        return;
      }
      this.squadIntroOpen = true;
      this._squadIntroComplete = onComplete;
      this._squadIntroBack = opts.onBack || null;
      this._squadIntroCustomize = opts.onCustomize || null;
      this._squadIntroTriggered = false;
      this._squadIntroRoster = (roster || []).slice(0, 4);
      if (this.els.squadIntroMapName) {
        this.els.squadIntroMapName.textContent = opts.mapName || '荒盆';
      }
      if (this.els.squadIntroModeName) {
        this.els.squadIntroModeName.textContent = opts.modeName || '单人游戏';
      }
      if (this.els.squadIntroFactionName) {
        this.els.squadIntroFactionName.textContent = opts.factionName || '和平军团';
      }
      this._buildSquadIntroCards();
      const playerEntry =
        this._squadIntroRoster.find((member) => member.isPlayer) ||
        this._squadIntroRoster[0];
      const classes = (global.VF.Soldier && global.VF.Soldier.CLASSES) || [];
      const classInfo =
        classes.find((item) => playerEntry && item.id === playerEntry.classId) ||
        classes[0];
      if (this.els.squadIntroCurrentClass && classInfo) {
        const name = classInfo.nameZh || (classInfo.label || '').split('|').pop().trim() || classInfo.nameEn || classInfo.id;
        this.els.squadIntroCurrentClass.textContent = /兵$/.test(name)
          ? name
          : name + '兵';
      }
      if (classInfo) this._syncDeployClassDetails(classInfo);
      this.els.squadIntroOverlay.classList.remove('hidden');
      this._bindSquadIntro();
      this._startSquadIntroPreview();
      this._startSquadIntroCountdown(opts.durationSec != null ? opts.durationSec : 5);
    },

    closeSquadIntro() {
      this.squadIntroOpen = false;
      this.closeArsenal();
      if (this._squadIntroTimer) {
        clearInterval(this._squadIntroTimer);
        this._squadIntroTimer = null;
      }
      if (this.els.squadIntroOverlay) {
        this.els.squadIntroOverlay.classList.add('hidden');
      }
      const self = this;
      setTimeout(function () {
        if (!self.squadIntroOpen) self._stopSquadIntroPreview();
      }, 250);
    },

    _squadGearIcon(kind) {
      const icons={
        medkit:'<svg viewBox="0 0 52 42" aria-hidden="true"><path fill-rule="evenodd" d="M7 11h38v27H7zm16 5h6v6h6v6h-6v6h-6v-6h-6v-6h6z"/><path d="M18 12V6h16v6" fill="none" stroke="currentColor" stroke-width="4"/></svg>',
        ammo:'<svg viewBox="0 0 58 42" aria-hidden="true"><path fill-rule="evenodd" d="M5 11h48v27H5zm10 6h6v16h-6zm11 0h6v16h-6zm11 0h6v16h-6z"/><path d="M17 12V5h24v7" fill="none" stroke="currentColor" stroke-width="4"/></svg>'
      };
      return icons[kind] || this._deployGearSvg(kind);
    },

    _squadClassIcon(id) {
      const icons = {
        assault: '<path d="M24 3l7 8-7 7-7-7zM6 13l14 8v9L8 23zM42 13l-14 8v9l12-7zM9 28l11 7v10l-9-6zM39 28l-11 7v10l9-6zM22 21h4v25h-4z"/>',
        engineer: '<path d="M31 3a13 13 0 00-13 17L3 35a5 5 0 007 7l16-16A13 13 0 0044 12l-9 7-7-7 7-8z"/>',
        support: '<path d="M6 15l4-9 4 9v5H6zm0 8h8v20H6zm14-12l4-9 4 9v5h-8zm0 8h8v24h-8zm14-4l4-9 4 9v5h-8zm0 8h8v20h-8z"/>',
        recon: '<circle cx="24" cy="24" r="14" fill="none" stroke="currentColor" stroke-width="3"/><path d="M22 2h4v15h-4zm0 29h4v15h-4zM2 22h15v4H2zm29 0h15v4H31z"/><circle cx="24" cy="24" r="3"/>',
        medic: '<path d="M16 3h16v13h13v16H32v13H16V32H3V16h13z"/>'
      };
      const key=/engineer/.test(id)?'engineer':/support|juggernaut/.test(id)?'support':/recon|ghost/.test(id)?'recon':id==='medic'?'medic':'assault';
      return '<svg viewBox="0 0 48 48" aria-hidden="true">'+icons[key]+'</svg>';
    },
    _buildSquadIntroCards() {
      const root = this.els.squadIntroCards;
      if (!root) return;
      root.replaceChildren();
      let aiIndex = 0;
      for (const member of this._squadIntroRoster) {
        const info = VF.Soldier.CLASSES.find(c => c.id === member.classId) || {};
        const card = document.createElement('article');
        card.className = 'squad-intro-card' + (member.isPlayer ? ' is-player' : '');
        const heading = document.createElement('strong');
        heading.className = 'squad-member-name';
        heading.textContent = member.isPlayer ? (member.name || '你') : 'AI 队友 ' + String(++aiIndex).padStart(2, '0');
        const row = document.createElement('div'); row.className = 'squad-member-class';
        const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = this._squadClassIcon(member.classId);
        const copy = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = member.className || info.nameZh || member.classId;
        const role = document.createElement('small'); role.textContent = info.role || '协同作战';
        copy.append(name, role); row.append(icon, copy);
        const equipment = document.createElement('div'); equipment.className = 'squad-card-gear';
        const types = [/engineer/.test(member.classId) ? 'shotgun' : 'rifle', /support|medic/.test(member.classId) ? 'medkit' : /recon|ghost/.test(member.classId) ? 'binoculars' : 'pistol', 'frag'];
        types.forEach((type, index) => {const slot=document.createElement('span');slot.innerHTML=this._squadGearIcon(type);if(index===0)slot.title=member.weapon||'兵种主武器';else slot.setAttribute('aria-hidden','true');equipment.append(slot);});
        card.append(heading, row, equipment); root.append(card);
      }
    },
    _bindSquadIntro() {
      if (this._squadIntroBound) return;
      this._squadIntroBound = true;
      if (this.els.squadIntroSkip) {
        this.els.squadIntroSkip.addEventListener('click', (e) => {
          e.preventDefault();
          this._finishSquadIntro();
        });
      }
      if (this.els.squadIntroBack) {
        this.els.squadIntroBack.addEventListener('click', (e) => {
          e.preventDefault();
          this._backFromSquadIntro();
        });
      }
      if (this.els.squadIntroCustomize) {
        this.els.squadIntroCustomize.addEventListener('click', (e) => {
          e.preventDefault();
          this._customizeFromSquadIntro();
        });
      }
      global.addEventListener('keydown', (e) => {
        if (!this.squadIntroOpen || e.repeat || this.arsenalOpen || (VF.Arsenal && VF.Arsenal.isOpen)) return;
        if (e.code === 'Escape') {
          e.preventDefault();
          this._backFromSquadIntro();
        } else if (e.code === 'KeyX') {
          e.preventDefault();
          this._customizeFromSquadIntro();
        } else if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          this._finishSquadIntro();
        }
      });
    },

    _startSquadIntroCountdown(seconds) {
      if (this._squadIntroTimer) clearInterval(this._squadIntroTimer);
      this._squadIntroEndsAt = performance.now() + Math.max(0, seconds) * 1000;
      let lastTick = performance.now();
      const tick = () => {
        if (!this.squadIntroOpen) {
          if (this._squadIntroTimer) clearInterval(this._squadIntroTimer);
          this._squadIntroTimer = null;
          return;
        }
        const now = performance.now();
        if (this.arsenalOpen || (VF.Arsenal && VF.Arsenal.isOpen)) this._squadIntroEndsAt += now - lastTick;
        lastTick = now;
        const left = Math.max(0, Math.ceil((this._squadIntroEndsAt - now) / 1000));
        if (this.els.squadIntroCountdown) {
          this.els.squadIntroCountdown.textContent = String(left);
        }
        if (left <= 0) this._finishSquadIntro();
      };
      this._squadIntroTimer = setInterval(tick, 200);
      tick();
    },

    _finishSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const done = this._squadIntroComplete;
      this.closeSquadIntro();
      if (typeof done === 'function') done();
    },

    _backFromSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const back = this._squadIntroBack;
      this.closeSquadIntro();
      if (typeof back === 'function') back();
    },

    _customizeFromSquadIntro() {
      if (!this.squadIntroOpen || this._squadIntroTriggered) return;
      this._squadIntroTriggered = true;
      const customize = this._squadIntroCustomize;
      const remainingSec = Math.max(
        0.2,
        (this._squadIntroEndsAt - performance.now()) / 1000
      );
      this.closeSquadIntro();
      if (typeof customize === 'function') customize(remainingSec);
    },

    _startSquadIntroPreview() {
      this._stopSquadIntroPreview();
      if (!global.THREE || !global.VF.Soldier || !this.els.squadIntroCanvas) return;
      const scene = new THREE.Scene();
      scene.background = null;
      const camera = new THREE.PerspectiveCamera(37, 16 / 9, 0.1, 40);
      camera.position.set(0, 1.05, 4.0);
      camera.lookAt(0, 1.02, 0);
      const key = new THREE.DirectionalLight(0xfff1dd, 1.35);
      key.position.set(-2, 6, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9bdcff, 0.68);
      rim.position.set(4, 3, -2);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xb8c5c8, 0.68));
      const renderer = this._getPresentationRenderer();
      if (!renderer) return;
      const positions = this._squadIntroRoster.length === 1 ? [0] : [-2.25, -0.75, 0.75, 2.25];
      const models = [];
      const previewTeam = this._playerTeam() === 'enemy' ? 'enemy' : 'ally';
      for (let i = 0; i < this._squadIntroRoster.length; i++) {
        const member = this._squadIntroRoster[i];
        const model = global.VF.Soldier.createPreviewSoldier(
          member.classId || 'assault',
          { team: previewTeam }
        );
        model.position.set(positions[i] || 0, 0, 0);
        model.rotation.y = Math.PI;
        if (global.VF.Soldier.initLocomotion) {
          global.VF.Soldier.initLocomotion(model);
        }
        scene.add(model);
        models.push(model);
      }
      this._squadIntroPreview = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        models: models,
        raf: 0,
        lastT: performance.now(),
        startedAt: performance.now(),
      };
      const tick = () => {
        const preview = this._squadIntroPreview;
        if (!this.squadIntroOpen || !preview) return;
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - preview.lastT) / 1000));
        preview.lastT = now;
        const elapsed = (now - preview.startedAt) / 1000;
        for (let i = 0; i < preview.models.length; i++) {
          const model = preview.models[i];
          model.rotation.y = Math.PI + Math.sin(elapsed * 0.42 + i) * 0.045;
          if (global.VF.Soldier.updateLocomotion) {
            global.VF.Soldier.updateLocomotion(model, dt, {
              moving: false,
              speedRatio: 0,
              onGround: true,
            });
          }
        }
        const canvas = this.els.squadIntroCanvas;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(global.devicePixelRatio || 1, 1.5);
        const w = Math.max(640, Math.round(rect.width * dpr) || 1280);
        const h = Math.max(360, Math.round(rect.height * dpr) || 720);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        preview.camera.aspect = w / Math.max(1, h);
        const distance=3.65;preview.camera.position.z=distance;
        const halfWidth=Math.tan(THREE.MathUtils.degToRad(preview.camera.fov/2))*distance*preview.camera.aspect;
        preview.models.forEach((model,i)=>{model.position.x=preview.models.length===1?0:halfWidth*(-.75+i*.5);});
        preview.camera.updateProjectionMatrix();
        preview.renderer.setSize(w, h, false);
        preview.renderer.render(preview.scene, preview.camera);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(preview.renderer.domElement, 0, 0, w, h);
        }
        preview.raf = requestAnimationFrame(tick);
      };
      this._squadIntroPreview.raf = requestAnimationFrame(tick);
    },

    _stopSquadIntroPreview() {
      const preview = this._squadIntroPreview;
      if (!preview) return;
      if (preview.raf) cancelAnimationFrame(preview.raf);
      for (let i = 0; i < preview.models.length; i++) {
        if (preview.models[i] && preview.scene) preview.scene.remove(preview.models[i]);
      }
      this._squadIntroPreview = null;
    },


});})(window);
