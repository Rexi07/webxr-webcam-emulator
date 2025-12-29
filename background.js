/**
 * WebXR Webcam Emulator Background Service Worker
 */

const SCRIPT_ID = 'webxr-webcam-emulator';

async function updateContentScript( enabled ) {

	try {

		await chrome.scripting.unregisterContentScripts( { ids: [ SCRIPT_ID ] } );

	} catch ( e ) {}

	if ( enabled ) {

		await chrome.scripting.registerContentScripts( [ {
			id: SCRIPT_ID,
			matches: [ '<all_urls>' ],
			js: [ 'polyfill.js' ],
			runAt: 'document_start',
			world: 'MAIN',
			allFrames: true
		} ] );

	}

}

chrome.runtime.onInstalled.addListener( async () => {

	const { enabled } = await chrome.storage.sync.get( { enabled: true } );
	await updateContentScript( enabled );

} );

chrome.runtime.onStartup.addListener( async () => {

	const { enabled } = await chrome.storage.sync.get( { enabled: true } );
	await updateContentScript( enabled );

} );

chrome.storage.onChanged.addListener( async ( changes, area ) => {

	if ( area === 'sync' && changes.enabled ) {

		await updateContentScript( changes.enabled.newValue );

	}

	if ( area === 'sync' && changes.stereo ) {

		await updateStereoConfig( changes.stereo.newValue );

	}

} );

async function updateStereoConfig( stereo ) {

	const tabs = await chrome.tabs.query( {} );

	for ( const tab of tabs ) {

		if ( tab.url && tab.url.startsWith( 'http' ) ) {

			try {

				await chrome.scripting.executeScript( {
					target: { tabId: tab.id, allFrames: true },
					world: 'MAIN',
					func: ( s ) => window.postMessage( { type: 'updateStereo', stereo: s }, '*' ),
					args: [ stereo ]
				} );

			} catch ( e ) {}

		}

	}

}
