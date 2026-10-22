// If you're already signed in, the buttons just open the app.
try{
  if(localStorage.getItem('aduna_in')||localStorage.getItem('aduna_token')){ // aduna_token: people who signed in before cookies existed
    document.querySelectorAll('a.go').forEach(function(a){a.textContent='Open Aduna';a.setAttribute('href','/app');});
    document.querySelectorAll('a.login').forEach(function(a){a.style.display='none'});
  }
}catch(e){}
