const toggle = document.getElementById( 'enable' );
const status = document.getElementById( 'status' );
const stereoToggle = document.getElementById( 'stereo' );

chrome.storage.sync.get( { enabled: true, stereo: false }, ( data ) => {

	toggle.checked = data.enabled;
	stereoToggle.checked = data.stereo;
	updateStatus( data.enabled );

} );

toggle.addEventListener( 'change', () => {

	const enabled = toggle.checked;
	chrome.storage.sync.set( { enabled } );
	updateStatus( enabled );

} );

stereoToggle.addEventListener( 'change', () => {

	chrome.storage.sync.set( { stereo: stereoToggle.checked } );

} );

function updateStatus( enabled ) {

	status.className = 'status ' + ( enabled ? 'on' : 'off' );
	status.textContent = enabled ? 'Enabled - Reload page' : 'Disabled';

}
