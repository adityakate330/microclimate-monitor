/* ========================================
   MicroClimate Monitor – Auth Logic
   ======================================== */

(function () {
  'use strict';

  // ---------- DOM Elements ----------
  const tabLogin        = document.getElementById('tabLogin');
  const tabSignup       = document.getElementById('tabSignup');
  const tabSlider       = document.getElementById('tabSlider');
  const loginForm       = document.getElementById('loginForm');
  const signupForm      = document.getElementById('signupForm');
  const loginBtn        = document.getElementById('loginBtn');
  const signupBtn       = document.getElementById('signupBtn');
  const messageBox      = document.getElementById('messageBox');
  const passwordStrength = document.getElementById('passwordStrength');
  const strengthLabel   = document.getElementById('strengthLabel');
  const switchToSignup  = document.getElementById('switchToSignup');
  const switchToLogin   = document.getElementById('switchToLogin');

  // ---------- Redirect if already logged in ----------
  if (localStorage.getItem('mcm_token') || sessionStorage.getItem('mcm_token')) {
    window.location.href = '/dashboard.html';
  }

  // ---------- Tab Switching ----------
  function setActiveTab(tab) {
    clearMessages();
    if (tab === 'login') {
      tabLogin.classList.add('active');
      tabSignup.classList.remove('active');
      tabSlider.classList.remove('right');
      loginForm.classList.add('active');
      signupForm.classList.remove('active');
    } else {
      tabSignup.classList.add('active');
      tabLogin.classList.remove('active');
      tabSlider.classList.add('right');
      signupForm.classList.add('active');
      loginForm.classList.remove('active');
    }
  }

  tabLogin.addEventListener('click', function () { setActiveTab('login'); });
  tabSignup.addEventListener('click', function () { setActiveTab('signup'); });
  switchToSignup.addEventListener('click', function (e) { e.preventDefault(); setActiveTab('signup'); });
  switchToLogin.addEventListener('click', function (e) { e.preventDefault(); setActiveTab('login'); });

  // ---------- Show / Hide Password ----------
  document.querySelectorAll('.toggle-password').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = btn.getAttribute('data-target');
      var input = document.getElementById(targetId);
      var icon = btn.querySelector('i');
      if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
      } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
      }
    });
  });

  // ---------- Password Strength ----------
  var signupPasswordInput = document.getElementById('signupPassword');

  signupPasswordInput.addEventListener('input', function () {
    var val = signupPasswordInput.value;
    if (val.length === 0) {
      passwordStrength.classList.remove('visible');
      return;
    }
    passwordStrength.classList.add('visible');

    var score = getPasswordScore(val);
    var bars = passwordStrength.querySelectorAll('.bar');

    // Reset
    bars.forEach(function (b) { b.className = 'bar'; });
    strengthLabel.className = 'strength-label';

    if (score <= 1) {
      bars[0].classList.add('weak');
      strengthLabel.classList.add('weak');
      strengthLabel.textContent = 'Weak';
    } else if (score === 2) {
      bars[0].classList.add('medium');
      bars[1].classList.add('medium');
      strengthLabel.classList.add('medium');
      strengthLabel.textContent = 'Fair';
    } else if (score === 3) {
      bars[0].classList.add('medium');
      bars[1].classList.add('medium');
      bars[2].classList.add('medium');
      strengthLabel.classList.add('medium');
      strengthLabel.textContent = 'Medium';
    } else {
      bars.forEach(function (b) { b.classList.add('strong'); });
      strengthLabel.classList.add('strong');
      strengthLabel.textContent = 'Strong';
    }
  });

  function getPasswordScore(pw) {
    var score = 0;
    if (pw.length >= 6)  score++;
    if (pw.length >= 10) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    return Math.min(score, 4);
  }

  // ---------- Validation Helpers ----------
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ---------- Messages ----------
  function showMessage(text, type) {
    var icon = type === 'error'
      ? '<i class="fa-solid fa-circle-exclamation"></i>'
      : '<i class="fa-solid fa-circle-check"></i>';
    messageBox.innerHTML = '<div class="msg ' + type + '">' + icon + '<span>' + text + '</span></div>';
  }

  function clearMessages() {
    messageBox.innerHTML = '';
  }

  // ---------- Button Loading State ----------
  function setLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // ---------- Storage Helper ----------
  function storeCredentials(token, user, remember) {
    var storage = remember ? localStorage : sessionStorage;
    storage.setItem('mcm_token', token);
    storage.setItem('mcm_user', JSON.stringify(user));
  }

  // ---------- Login ----------
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMessages();

    var email    = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    var remember = document.getElementById('rememberMe').checked;

    // Validate
    if (!email || !password) {
      return showMessage('Please fill in all fields.', 'error');
    }
    if (!isValidEmail(email)) {
      return showMessage('Please enter a valid email address.', 'error');
    }
    if (password.length < 6) {
      return showMessage('Password must be at least 6 characters.', 'error');
    }

    setLoading(loginBtn, true);

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        setLoading(loginBtn, false);
        if (data.success) {
          storeCredentials(data.token, data.user, remember);
          showMessage('Login successful! Redirecting…', 'success');
          setTimeout(function () { window.location.href = '/dashboard.html'; }, 800);
        } else {
          showMessage(data.message || 'Invalid email or password.', 'error');
        }
      })
      .catch(function () {
        setLoading(loginBtn, false);
        showMessage('Network error. Please try again.', 'error');
      });
  });

  // ---------- Signup ----------
  signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMessages();

    var name     = document.getElementById('signupName').value.trim();
    var email    = document.getElementById('signupEmail').value.trim();
    var password = document.getElementById('signupPassword').value;
    var confirm  = document.getElementById('signupConfirmPassword').value;

    // Validate
    if (!name || !email || !password || !confirm) {
      return showMessage('Please fill in all fields.', 'error');
    }
    if (name.length < 2) {
      return showMessage('Name must be at least 2 characters.', 'error');
    }
    if (!isValidEmail(email)) {
      return showMessage('Please enter a valid email address.', 'error');
    }
    if (password.length < 6) {
      return showMessage('Password must be at least 6 characters.', 'error');
    }
    if (password !== confirm) {
      return showMessage('Passwords do not match.', 'error');
    }

    setLoading(signupBtn, true);

    fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, password: password })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        setLoading(signupBtn, false);
        if (data.success) {
          storeCredentials(data.token, data.user, false);
          showMessage('Account created! Redirecting…', 'success');
          setTimeout(function () { window.location.href = '/dashboard.html'; }, 800);
        } else {
          showMessage(data.message || 'Signup failed. Please try again.', 'error');
        }
      })
      .catch(function () {
        setLoading(signupBtn, false);
        showMessage('Network error. Please try again.', 'error');
      });
  });

})();
