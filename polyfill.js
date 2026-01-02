/**
 * WebXR Webcam Emulator Polyfill
 * Emulates WebXR head and hand tracking using MediaPipe
 */

( function () {

	'use strict';

	// --------------------------------------------------
	// Constants
	// --------------------------------------------------

	const HAND_JOINTS = [
		'wrist',
		'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
		'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
		'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
		'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
		'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'
	];

	// --------------------------------------------------
	// State
	// --------------------------------------------------

	let videoElement = null;
	let faceLandmarker = null;
	let handLandmarker = null;
	let isTracking = false;
	let currentSession = null;

	// Tracking data
	let headPosition = { x: 0, y: 0, z: - 0.5 };
	let headRotation = { x: 0, y: 0, z: 0, w: 1 };
	let leftHandData = null;
	let rightHandData = null;

	// Configuration
	const config = {
		positionScale: 0.5,
		depthScale: 0.3,
		smoothing: 0.7,
		standingHeight: 1.8, // Standing eye height in meters
		stereo: false
	};

	// Listen for stereo config updates from background script
	window.addEventListener( 'message', ( event ) => {

		if ( event.data && event.data.type === 'updateStereo' && event.data.stereo !== undefined ) {

			config.stereo = event.data.stereo;

		}

	} );

	// --------------------------------------------------
	// MediaPipe Setup
	// --------------------------------------------------

	function showError( message ) {

		const errorDiv = document.createElement( 'div' );
		errorDiv.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ff4444;color:#fff;padding:16px 24px;border-radius:8px;font-family:system-ui,sans-serif;font-size:14px;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
		errorDiv.textContent = '[WebXR Webcam Emulator] ' + message;
		document.body.appendChild( errorDiv );

		setTimeout( () => errorDiv.remove(), 5000 );

	}

	async function initializeMediaPipe() {

		try {

			const vision = await import( 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs' );
			const { FaceLandmarker, HandLandmarker, FilesetResolver } = vision;

			const filesetResolver = await FilesetResolver.forVisionTasks(
				'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
			);

			faceLandmarker = await FaceLandmarker.createFromOptions( filesetResolver, {
				baseOptions: {
					modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
					delegate: 'GPU'
				},
				runningMode: 'VIDEO',
				numFaces: 1,
				outputFaceBlendshapes: false,
				outputFacialTransformationMatrixes: true
			} );

			handLandmarker = await HandLandmarker.createFromOptions( filesetResolver, {
				baseOptions: {
					modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
					delegate: 'GPU'
				},
				runningMode: 'VIDEO',
				numHands: 2
			} );

		} catch ( e ) {

			showError( 'Failed to load MediaPipe models. Check your internet connection.' );
			throw e;

		}

	}

	async function startCamera() {

		videoElement = document.createElement( 'video' );
		videoElement.setAttribute( 'playsinline', '' );
		videoElement.style.cssText = 'position:fixed;bottom:10px;right:10px;width:160px;height:120px;z-index:999999;border-radius:8px;border:2px solid #00ff00;transform:scaleX(-1);';
		document.body.appendChild( videoElement );

		try {

			const stream = await navigator.mediaDevices.getUserMedia( {
				video: { width: 640, height: 480, facingMode: 'user' }
			} );

			videoElement.srcObject = stream;
			await videoElement.play();

		} catch ( e ) {

			videoElement.remove();
			videoElement = null;

			if ( e.name === 'NotAllowedError' ) {

				showError( 'Camera permission denied. Please allow camera access and reload.' );

			} else {

				showError( 'Could not access camera: ' + e.message );

			}

			throw e;

		}

	}

	function stopCamera() {

		if ( videoElement ) {

			const stream = videoElement.srcObject;
			if ( stream ) stream.getTracks().forEach( track => track.stop() );
			videoElement.remove();
			videoElement = null;

		}

	}

	let lastVideoTime = - 1;

	function processFrame() {

		if ( ! isTracking || ! videoElement || videoElement.readyState < 2 ) return;
		if ( ! faceLandmarker || ! handLandmarker ) return;

		const currentTime = videoElement.currentTime;
		if ( currentTime === lastVideoTime ) return;
		lastVideoTime = currentTime;

		const timestamp = performance.now();

		// Process face
		const faceResults = faceLandmarker.detectForVideo( videoElement, timestamp );

		if ( faceResults.facialTransformationMatrixes && faceResults.facialTransformationMatrixes.length > 0 ) {

			updateHeadFromMatrix( faceResults.facialTransformationMatrixes[ 0 ].data );

		} else if ( faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0 ) {

			updateHeadFromLandmarks( faceResults.faceLandmarks[ 0 ] );

		}

		// Process hands
		const handResults = handLandmarker.detectForVideo( videoElement, timestamp );

		leftHandData = null;
		rightHandData = null;

		if ( handResults.landmarks && handResults.handednesses ) {

			for ( let i = 0; i < handResults.landmarks.length; i ++ ) {

				const handedness = handResults.handednesses[ i ][ 0 ].categoryName;
				const landmarks = handResults.landmarks[ i ];
				const worldLandmarks = handResults.worldLandmarks ? handResults.worldLandmarks[ i ] : null;

				// Mirror: MediaPipe "Left" is user's left hand
				if ( handedness === 'Left' ) {

					leftHandData = processHandLandmarks( landmarks, worldLandmarks, 'left' );

				} else {

					rightHandData = processHandLandmarks( landmarks, worldLandmarks, 'right' );

				}

			}

		}

	}

	function updateHeadFromMatrix( matrixData ) {

		// MediaPipe facial transformation matrix is 4x4 column-major
		// m[0-3] = column 0, m[4-7] = column 1, m[8-11] = column 2, m[12-15] = column 3
		const m = matrixData;

		// Extract position (translation from column 3)
		const tx = m[ 12 ];
		const ty = m[ 13 ];
		const tz = m[ 14 ];

		// Position: MediaPipe gives cm-scale values, convert to meters
		// tx/ty are lateral movement, tz is depth (distance from camera)
		// Typical face distance is ~50cm, so tz around -30 to -50 is normal
		const targetX = - tx * 0.02;
		const targetY = - ty * 0.02;
		const targetZ = - ( tz + 50 ) * 0.02;

		headPosition.x = lerp( headPosition.x, targetX, 1 - config.smoothing );
		headPosition.y = lerp( headPosition.y, targetY, 1 - config.smoothing );
		headPosition.z = lerp( headPosition.z, targetZ, 1 - config.smoothing );

		// Extract rotation quaternion from rotation matrix (upper-left 3x3)
		// Using algorithm from three.js Matrix4.decompose
		const m11 = m[ 0 ], m12 = m[ 4 ], m13 = m[ 8 ];
		const m21 = m[ 1 ], m22 = m[ 5 ], m23 = m[ 9 ];
		const m31 = m[ 2 ], m32 = m[ 6 ], m33 = m[ 10 ];

		const trace = m11 + m22 + m33;
		let qx, qy, qz, qw;

		if ( trace > 0 ) {

			const s = 0.5 / Math.sqrt( trace + 1.0 );
			qw = 0.25 / s;
			qx = ( m32 - m23 ) * s;
			qy = ( m13 - m31 ) * s;
			qz = ( m21 - m12 ) * s;

		} else if ( m11 > m22 && m11 > m33 ) {

			const s = 2.0 * Math.sqrt( 1.0 + m11 - m22 - m33 );
			qw = ( m32 - m23 ) / s;
			qx = 0.25 * s;
			qy = ( m12 + m21 ) / s;
			qz = ( m13 + m31 ) / s;

		} else if ( m22 > m33 ) {

			const s = 2.0 * Math.sqrt( 1.0 + m22 - m11 - m33 );
			qw = ( m13 - m31 ) / s;
			qx = ( m12 + m21 ) / s;
			qy = 0.25 * s;
			qz = ( m23 + m32 ) / s;

		} else {

			const s = 2.0 * Math.sqrt( 1.0 + m33 - m11 - m22 );
			qw = ( m21 - m12 ) / s;
			qx = ( m13 + m31 ) / s;
			qy = ( m23 + m32 ) / s;
			qz = 0.25 * s;

		}

		// Normalize and flip for mirrored camera view
		const len = Math.sqrt( qx * qx + qy * qy + qz * qz + qw * qw );
		const targetQx = - qx / len;
		const targetQy = qy / len;
		const targetQz = qz / len;
		const targetQw = qw / len;

		// Smooth rotation using simple lerp (not ideal but works for small changes)
		headRotation.x = lerp( headRotation.x, targetQx, 1 - config.smoothing );
		headRotation.y = lerp( headRotation.y, targetQy, 1 - config.smoothing );
		headRotation.z = lerp( headRotation.z, targetQz, 1 - config.smoothing );
		headRotation.w = lerp( headRotation.w, targetQw, 1 - config.smoothing );

		// Renormalize after lerp
		const rlen = Math.sqrt( headRotation.x ** 2 + headRotation.y ** 2 + headRotation.z ** 2 + headRotation.w ** 2 );
		headRotation.x /= rlen;
		headRotation.y /= rlen;
		headRotation.z /= rlen;
		headRotation.w /= rlen;

	}

	function updateHeadFromLandmarks( landmarks ) {

		const nose = landmarks[ 1 ];

		const targetX = - ( nose.x - 0.5 ) * config.positionScale;
		const targetY = - ( nose.y - 0.5 ) * config.positionScale;
		const targetZ = - 0.5 + nose.z * config.depthScale;

		headPosition.x = lerp( headPosition.x, targetX, 1 - config.smoothing );
		headPosition.y = lerp( headPosition.y, targetY, 1 - config.smoothing );
		headPosition.z = lerp( headPosition.z, targetZ, 1 - config.smoothing );

	}

	function processHandLandmarks( landmarks, worldLandmarks, handedness ) {

		const joints = [];
		const useWorld = worldLandmarks && worldLandmarks.length > 0;

		// Get wrist position from normalized landmarks to determine hand center in screen space
		const wristScreen = landmarks[ 0 ];

		// Convert screen position to world position, relative to head
		// Screen x: 0-1, center is 0.5. Mirror it for natural movement.
		// Screen y: 0-1, top is 0, bottom is 1
		const offsetX = - ( wristScreen.x - 0.5 ) * 1.2; // Mirrored, scaled to ~60cm range each side
		const offsetY = - ( wristScreen.y - 0.5 ) * 0.8 - 0.3; // Scaled, offset below head
		const offsetZ = - 0.5 - wristScreen.z * 0.3; // Depth in front of head

		// Position hands relative to head
		const screenX = headPosition.x + offsetX;
		const screenY = headPosition.y + config.standingHeight + offsetY;
		const screenZ = headPosition.z + offsetZ;

		for ( let i = 0; i < 21; i ++ ) {

			let x, y, z;

			if ( useWorld ) {

				// World landmarks are in meters, relative to wrist
				// MediaPipe: +X right, +Y DOWN, +Z toward camera
				// WebXR: +X right, +Y UP, -Z forward
				const lm = worldLandmarks[ i ];
				const wristWorld = worldLandmarks[ 0 ];

				// Get position relative to wrist
				const relX = ( lm.x - wristWorld.x );
				const relY = ( lm.y - wristWorld.y );
				const relZ = ( lm.z - wristWorld.z );

				// Convert to WebXR space:
				// - Mirror X for camera view (screenX already mirrored, so subtract relX to mirror)
				// - Flip Y: MediaPipe +Y down means finger above wrist has negative relY
				//   WebXR +Y up means finger above wrist needs positive offset, so subtract relY
				// - Z: MediaPipe +Z toward camera, finger further has negative relZ
				//   WebXR -Z forward, finger further needs negative offset, so add relZ
				x = screenX - relX;
				y = screenY - relY;
				z = screenZ + relZ;

			} else {

				// Normalized landmarks - use relative to wrist
				// Normalized coords: +Y is down (screen coordinates), same as MediaPipe world
				const lm = landmarks[ i ];
				const wristLm = landmarks[ 0 ];

				const relX = ( lm.x - wristLm.x ) * 0.3;
				const relY = ( lm.y - wristLm.y ) * 0.3;
				const relZ = ( lm.z - wristLm.z ) * 0.15;

				// Convert same as world landmarks
				x = screenX - relX;
				y = screenY - relY;
				z = screenZ + relZ;

			}

			joints.push( { position: { x, y, z }, radius: 0.01 } );

		}

		// Expand 21 MediaPipe joints to 25 WebXR joints
		const webxrJoints = new Array( 25 );

		webxrJoints[ 0 ] = joints[ 0 ]; // wrist

		// Thumb
		webxrJoints[ 1 ] = joints[ 1 ];
		webxrJoints[ 2 ] = joints[ 2 ];
		webxrJoints[ 3 ] = joints[ 3 ];
		webxrJoints[ 4 ] = joints[ 4 ];

		// Index
		webxrJoints[ 5 ] = interpolateJoint( joints[ 0 ], joints[ 5 ], 0.5 );
		webxrJoints[ 6 ] = joints[ 5 ];
		webxrJoints[ 7 ] = joints[ 6 ];
		webxrJoints[ 8 ] = joints[ 7 ];
		webxrJoints[ 9 ] = joints[ 8 ];

		// Middle
		webxrJoints[ 10 ] = interpolateJoint( joints[ 0 ], joints[ 9 ], 0.5 );
		webxrJoints[ 11 ] = joints[ 9 ];
		webxrJoints[ 12 ] = joints[ 10 ];
		webxrJoints[ 13 ] = joints[ 11 ];
		webxrJoints[ 14 ] = joints[ 12 ];

		// Ring
		webxrJoints[ 15 ] = interpolateJoint( joints[ 0 ], joints[ 13 ], 0.5 );
		webxrJoints[ 16 ] = joints[ 13 ];
		webxrJoints[ 17 ] = joints[ 14 ];
		webxrJoints[ 18 ] = joints[ 15 ];
		webxrJoints[ 19 ] = joints[ 16 ];

		// Pinky
		webxrJoints[ 20 ] = interpolateJoint( joints[ 0 ], joints[ 17 ], 0.5 );
		webxrJoints[ 21 ] = joints[ 17 ];
		webxrJoints[ 22 ] = joints[ 18 ];
		webxrJoints[ 23 ] = joints[ 19 ];
		webxrJoints[ 24 ] = joints[ 20 ];

		// Compute palm normal from wrist, index MCP, and pinky MCP
		// This defines the "up" direction for the hand (back of hand / dorsal direction)
		const wrist = webxrJoints[ 0 ].position;
		const indexMcp = webxrJoints[ 6 ].position; // index-finger-phalanx-proximal
		const pinkyMcp = webxrJoints[ 21 ].position; // pinky-finger-phalanx-proximal

		// Vector from wrist to index (for right hand: left side)
		const toIndexX = indexMcp.x - wrist.x;
		const toIndexY = indexMcp.y - wrist.y;
		const toIndexZ = indexMcp.z - wrist.z;

		// Vector from wrist to pinky (for right hand: right side)
		const toPinkyX = pinkyMcp.x - wrist.x;
		const toPinkyY = pinkyMcp.y - wrist.y;
		const toPinkyZ = pinkyMcp.z - wrist.z;

		// Palm normal = cross product (toPinky × toIndex for right hand)
		// For right hand palm-down: this gives +Y (dorsal/back of hand)
		// Using right-hand rule: pinky-to-index cross gives upward normal
		let palmNormalX = toPinkyY * toIndexZ - toPinkyZ * toIndexY;
		let palmNormalY = toPinkyZ * toIndexX - toPinkyX * toIndexZ;
		let palmNormalZ = toPinkyX * toIndexY - toPinkyY * toIndexX;

		// Normalize
		const palmLen = Math.sqrt( palmNormalX * palmNormalX + palmNormalY * palmNormalY + palmNormalZ * palmNormalZ );
		if ( palmLen > 0.0001 ) {

			palmNormalX /= palmLen;
			palmNormalY /= palmLen;
			palmNormalZ /= palmLen;

		} else {

			palmNormalX = 0;
			palmNormalY = 1;
			palmNormalZ = 0;

		}

		// For left hand, flip the normal (mirror of right hand)
		if ( handedness === 'left' ) {

			palmNormalX = - palmNormalX;
			palmNormalY = - palmNormalY;
			palmNormalZ = - palmNormalZ;

		}

		return {
			joints: webxrJoints,
			visible: true,
			palmNormal: { x: palmNormalX, y: palmNormalY, z: palmNormalZ },
			handedness: handedness
		};

	}

	function interpolateJoint( a, b, t ) {

		return {
			position: {
				x: a.position.x + ( b.position.x - a.position.x ) * t,
				y: a.position.y + ( b.position.y - a.position.y ) * t,
				z: a.position.z + ( b.position.z - a.position.z ) * t
			},
			radius: 0.01
		};

	}

	function lerp( a, b, t ) {

		return a + ( b - a ) * t;

	}

	// --------------------------------------------------
	// WebXR Classes
	// --------------------------------------------------

	class XRSystem extends EventTarget {

		constructor() {

			super();
			this.ondevicechange = null;

		}

		async isSessionSupported( mode ) {

			return mode === 'immersive-vr' || mode === 'immersive-ar' || mode === 'inline';

		}

		async requestSession( mode, options = {} ) {

			if ( currentSession ) {

				throw new DOMException( 'Session already active', 'InvalidStateError' );

			}

			currentSession = new XRSession( mode, options );
			isTracking = true;

			// Initialize tracking in background
			initializeMediaPipe()
				.then( () => startCamera() )
				.catch( ( err ) => console.error( '[WebXR Webcam Emulator] Tracking error:', err ) );

			return currentSession;

		}

	}

	class XRSession extends EventTarget {

		constructor( mode, options ) {

			super();

			this.mode = mode;
			this.environmentBlendMode = mode === 'immersive-ar' ? 'alpha-blend' : 'opaque';
			this.visibilityState = 'visible';
			this.renderState = {
				baseLayer: null,
				depthNear: 0.1,
				depthFar: 1000.0,
				inlineVerticalFieldOfView: Math.PI / 2
			};
			this.inputSources = new XRInputSourceArray();

			this._options = options;
			this._frameCallbacks = new Map();
			this._nextCallbackId = 1;
			this._animationFrameId = null;
			this._ended = false;
			this._referenceSpaces = new Map();

			// Check both requiredFeatures and optionalFeatures for hand-tracking
			const requiredFeatures = options.requiredFeatures || [];
			const optionalFeatures = options.optionalFeatures || [];

			// Always enable controller emulation from hand tracking
			this.inputSources._session = this;
			this.inputSources._handTrackingEnabled = requiredFeatures.includes( 'hand-tracking' ) || optionalFeatures.includes( 'hand-tracking' );

			this._startFrameLoop();

		}

		get supportedFrameRates() { return null; }
		get frameRate() { return 60; }

		updateRenderState( state ) {

			Object.assign( this.renderState, state );

		}

		async requestReferenceSpace( type ) {

			if ( ! this._referenceSpaces.has( type ) ) {

				this._referenceSpaces.set( type, new XRReferenceSpace( type ) );

			}

			return this._referenceSpaces.get( type );

		}

		requestAnimationFrame( callback ) {

			const id = this._nextCallbackId ++;
			this._frameCallbacks.set( id, callback );
			return id;

		}

		cancelAnimationFrame( id ) {

			this._frameCallbacks.delete( id );

		}

		async end() {

			this._ended = true;
			isTracking = false;

			if ( this._animationFrameId ) cancelAnimationFrame( this._animationFrameId );

			stopCamera();
			currentSession = null;

			this.dispatchEvent( new XRSessionEvent( 'end', { session: this } ) );

		}

		_startFrameLoop() {

			const loop = ( timestamp ) => {

				if ( this._ended ) return;

				processFrame();
				this.inputSources._update( leftHandData, rightHandData );

				const frame = new XRFrame( this, timestamp );

				this._currentFrame = frame;
				const callbacks = new Map( this._frameCallbacks );
				this._frameCallbacks.clear();

				frame._active = true;

				for ( const [ , callback ] of callbacks ) {

					try {

						callback( timestamp, frame );

					} catch ( err ) {

						console.error( '[WebXR Webcam Emulator] Frame error:', err );

					}

				}

				frame._active = false;
				this._animationFrameId = requestAnimationFrame( loop );

			};

			this._animationFrameId = requestAnimationFrame( loop );

		}

	}

	class XRSessionEvent extends Event {

		constructor( type, init ) {

			super( type );
			this.session = init.session;

		}

	}

	class XRSelectEvent extends Event {

		constructor( type, init ) {

			super( type );
			this.inputSource = init.inputSource;
			this.frame = init.frame || null;
			this.session = init.session;

		}

	}

	class XRFrame {

		constructor( session, timestamp ) {

			this.session = session;
			this._timestamp = timestamp;
			this._active = false;

		}

		getViewerPose( referenceSpace ) {

			return new XRViewerPose( referenceSpace );

		}

		getPose( space ) {

			if ( space instanceof XRJointSpace ) return space._getPose();
			if ( space instanceof XRSpace ) return new XRPose( space._transform );
			return null;

		}

		getJointPose( joint ) {

			if ( joint instanceof XRJointSpace ) return joint._getJointPose();
			return null;

		}

		fillJointRadii( jointSpaces, radii ) {

			for ( let i = 0; i < jointSpaces.length; i ++ ) {

				radii[ i ] = jointSpaces[ i ] ? jointSpaces[ i ]._radius : 0;

			}

			return true;

		}

		fillPoses( spaces, transforms ) {

			for ( let i = 0; i < spaces.length; i ++ ) {

				const pose = this.getPose( spaces[ i ] );
				if ( pose ) {

					const m = pose.transform.matrix;
					for ( let j = 0; j < 16; j ++ ) transforms[ i * 16 + j ] = m[ j ];

				}

			}

			return true;

		}

	}

	class XRViewerPose {

		constructor( referenceSpace ) {

			// Determine height offset based on reference space type
			// 'local-floor' and 'bounded-floor': Y=0 is at floor level, add standing height
			// 'local': Y=0 is at initial head position (seated-scale), no floor offset
			// 'viewer': Origin is always at the head, no offset
			let heightOffset = 0;
			if ( referenceSpace._type === 'local-floor' || referenceSpace._type === 'bounded-floor' ) {

				heightOffset = config.standingHeight;

			}

			let posX = headPosition.x;
			let posY = headPosition.y + heightOffset;
			let posZ = headPosition.z;

			// Apply origin offset if set via getOffsetReferenceSpace
			if ( referenceSpace._originOffset ) {

				const offset = referenceSpace._originOffset;
				posX -= offset.position.x;
				posY -= offset.position.y;
				posZ -= offset.position.z;

			}

			const position = new DOMPointReadOnly( posX, posY, posZ, 1 );
			const orientation = new DOMPointReadOnly( headRotation.x, headRotation.y, headRotation.z, headRotation.w );

			this.transform = new XRRigidTransform( position, orientation );
			this.emulatedPosition = true;

			if ( config.stereo ) {

				this.views = [
					new XRView( 'left', this.transform ),
					new XRView( 'right', this.transform )
				];

			} else {

				this.views = [
					new XRView( 'none', this.transform )
				];

			}

		}

	}

	class XRView {

		constructor( eye, viewerTransform ) {

			this.eye = eye;
			this.camera = new XRCamera();
			this.recommendedViewportScale = 1;

			const eyeOffset = eye === 'left' ? - 0.032 : ( eye === 'right' ? 0.032 : 0 );

			const position = new DOMPointReadOnly(
				viewerTransform.position.x + eyeOffset,
				viewerTransform.position.y,
				viewerTransform.position.z,
				1
			);

			this.transform = new XRRigidTransform( position, viewerTransform.orientation );

			const near = 0.1, far = 1000, fov = Math.PI / 2, f = 1.0 / Math.tan( fov / 2 );

			this.projectionMatrix = new Float32Array( [
				f, 0, 0, 0,
				0, f, 0, 0,
				0, 0, ( far + near ) / ( near - far ), - 1,
				0, 0, ( 2 * far * near ) / ( near - far ), 0
			] );

		}

		requestViewportScale( scale ) {

			this.recommendedViewportScale = scale;

		}

	}

	class XRCamera {

		get width() {

			return videoElement ? videoElement.videoWidth : 0;

		}

		get height() {

			return videoElement ? videoElement.videoHeight : 0;

		}

	}

	class XRReferenceSpace extends EventTarget {

		constructor( type ) {

			super();
			this._type = type;

		}

		getOffsetReferenceSpace( originOffset ) {

			const space = new XRReferenceSpace( this._type );
			space._originOffset = originOffset;
			return space;

		}

	}

	class XRSpace {

		constructor() {

			this._transform = new XRRigidTransform();

		}

	}

	// Map each joint index to the next joint in the chain for orientation calculation
	const JOINT_CHAIN_NEXT = {
		0: 5,   // wrist -> index metacarpal (center of hand)
		1: 2, 2: 3, 3: 4, 4: 4,      // thumb chain
		5: 6, 6: 7, 7: 8, 8: 9, 9: 9,      // index chain
		10: 11, 11: 12, 12: 13, 13: 14, 14: 14, // middle chain
		15: 16, 16: 17, 17: 18, 18: 19, 19: 19, // ring chain
		20: 21, 21: 22, 22: 23, 23: 24, 24: 24  // pinky chain
	};

	// Compute quaternion that orients a bone from current joint toward next joint
	// with proper roll constraint using the palm normal as up reference
	function computeJointOrientation( joints, jointIndex, palmNormal, handedness ) {

		const current = joints[ jointIndex ];
		const nextIndex = JOINT_CHAIN_NEXT[ jointIndex ];
		const next = joints[ nextIndex ];

		if ( ! current || ! next || jointIndex === nextIndex ) {

			return { x: 0, y: 0, z: 0, w: 1 };

		}

		// Direction from current to next joint (this will be -Z in bone space)
		let fwdX = next.position.x - current.position.x;
		let fwdY = next.position.y - current.position.y;
		let fwdZ = next.position.z - current.position.z;

		const fwdLen = Math.sqrt( fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ );
		if ( fwdLen < 0.0001 ) return { x: 0, y: 0, z: 0, w: 1 };

		fwdX /= fwdLen;
		fwdY /= fwdLen;
		fwdZ /= fwdLen;

		// For WebXR: -Z along bone (toward fingertip), +Y toward back of hand
		let upRefX, upRefY, upRefZ;

		// Thumb joints (1-4) need special handling - thumb is rotated ~90° from other fingers
		if ( jointIndex >= 1 && jointIndex <= 4 ) {

			// For thumb, compute up reference perpendicular to both thumb direction and palm normal
			// This gives the thumb's "radial" direction (toward index finger)
			// thumbRight = palmNormal × thumbForward
			let thumbRightX = palmNormal.y * fwdZ - palmNormal.z * fwdY;
			let thumbRightY = palmNormal.z * fwdX - palmNormal.x * fwdZ;
			let thumbRightZ = palmNormal.x * fwdY - palmNormal.y * fwdX;

			const thumbRightLen = Math.sqrt( thumbRightX * thumbRightX + thumbRightY * thumbRightY + thumbRightZ * thumbRightZ );
			if ( thumbRightLen > 0.0001 ) {

				thumbRightX /= thumbRightLen;
				thumbRightY /= thumbRightLen;
				thumbRightZ /= thumbRightLen;

				// For thumb, the "up" (dorsal) direction is roughly the thumb's radial direction
				// Flip based on handedness for correct orientation
				const sign = handedness === 'left' ? - 1 : 1;
				upRefX = thumbRightX * sign;
				upRefY = thumbRightY * sign;
				upRefZ = thumbRightZ * sign;

			} else {

				upRefX = palmNormal.x;
				upRefY = palmNormal.y;
				upRefZ = palmNormal.z;

			}

		} else {

			// For other fingers, use palm normal as up reference
			upRefX = palmNormal.x;
			upRefY = palmNormal.y;
			upRefZ = palmNormal.z;

		}

		// Right = forward × up (cross product)
		let rightX = fwdY * upRefZ - fwdZ * upRefY;
		let rightY = fwdZ * upRefX - fwdX * upRefZ;
		let rightZ = fwdX * upRefY - fwdY * upRefX;

		let rightLen = Math.sqrt( rightX * rightX + rightY * rightY + rightZ * rightZ );

		if ( rightLen < 0.0001 ) {

			// Forward is parallel to up, use world up as fallback
			upRefX = 0;
			upRefY = 1;
			upRefZ = 0;
			rightX = fwdY * upRefZ - fwdZ * upRefY;
			rightY = fwdZ * upRefX - fwdX * upRefZ;
			rightZ = fwdX * upRefY - fwdY * upRefX;
			rightLen = Math.sqrt( rightX * rightX + rightY * rightY + rightZ * rightZ );

			if ( rightLen < 0.0001 ) {

				rightX = 1;
				rightY = 0;
				rightZ = 0;
				rightLen = 1;

			}

		}

		rightX /= rightLen;
		rightY /= rightLen;
		rightZ /= rightLen;

		// Recompute up = right × forward (to ensure orthogonal)
		const upX = rightY * fwdZ - rightZ * fwdY;
		const upY = rightZ * fwdX - rightX * fwdZ;
		const upZ = rightX * fwdY - rightY * fwdX;

		// Build rotation matrix: columns are right, up, -forward
		// (because WebXR expects -Z along bone toward fingertip)
		const m00 = rightX, m01 = upX, m02 = - fwdX;
		const m10 = rightY, m11 = upY, m12 = - fwdY;
		const m20 = rightZ, m21 = upZ, m22 = - fwdZ;

		// Matrix to quaternion
		const trace = m00 + m11 + m22;
		let qx, qy, qz, qw;

		if ( trace > 0 ) {

			const s = 0.5 / Math.sqrt( trace + 1.0 );
			qw = 0.25 / s;
			qx = ( m21 - m12 ) * s;
			qy = ( m02 - m20 ) * s;
			qz = ( m10 - m01 ) * s;

		} else if ( m00 > m11 && m00 > m22 ) {

			const s = 2.0 * Math.sqrt( 1.0 + m00 - m11 - m22 );
			qw = ( m21 - m12 ) / s;
			qx = 0.25 * s;
			qy = ( m01 + m10 ) / s;
			qz = ( m02 + m20 ) / s;

		} else if ( m11 > m22 ) {

			const s = 2.0 * Math.sqrt( 1.0 + m11 - m00 - m22 );
			qw = ( m02 - m20 ) / s;
			qx = ( m01 + m10 ) / s;
			qy = 0.25 * s;
			qz = ( m12 + m21 ) / s;

		} else {

			const s = 2.0 * Math.sqrt( 1.0 + m22 - m00 - m11 );
			qw = ( m10 - m01 ) / s;
			qx = ( m02 + m20 ) / s;
			qy = ( m12 + m21 ) / s;
			qz = 0.25 * s;

		}

		return { x: qx, y: qy, z: qz, w: qw };

	}

	class XRJointSpace extends XRSpace {

		constructor( jointName, handData, jointIndex ) {

			super();
			this.jointName = jointName;
			this._handData = handData;
			this._jointIndex = jointIndex;
			this._radius = 0.01;

		}

		_getPose() {

			const joints = this._handData.joints;
			const joint = joints[ this._jointIndex ];
			if ( ! joint ) return null;

			const palmNormal = this._handData.palmNormal || { x: 0, y: 1, z: 0 };
			const handedness = this._handData.handedness || 'right';

			const position = new DOMPointReadOnly( joint.position.x, joint.position.y, joint.position.z, 1 );
			const q = computeJointOrientation( joints, this._jointIndex, palmNormal, handedness );
			const orientation = new DOMPointReadOnly( q.x, q.y, q.z, q.w );

			return new XRPose( new XRRigidTransform( position, orientation ) );

		}

		_getJointPose() {

			const pose = this._getPose();
			if ( ! pose ) return null;
			return new XRJointPose( pose.transform, this._radius );

		}

	}

	class XRPose {

		constructor( transform ) {

			this.transform = transform;
			this.emulatedPosition = true;
			this.linearVelocity = null;
			this.angularVelocity = null;

		}

	}

	class XRJointPose extends XRPose {

		constructor( transform, radius ) {

			super( transform );
			this.radius = radius;

		}

	}

	class XRRigidTransform {

		constructor( position, orientation ) {

			this.position = position || new DOMPointReadOnly( 0, 0, 0, 1 );
			this.orientation = orientation || new DOMPointReadOnly( 0, 0, 0, 1 );
			this._matrix = null;

		}

		get matrix() {

			if ( ! this._matrix ) {

				this._matrix = new Float32Array( 16 );

				const x = this.orientation.x, y = this.orientation.y, z = this.orientation.z, w = this.orientation.w;
				const x2 = x + x, y2 = y + y, z2 = z + z;
				const xx = x * x2, xy = x * y2, xz = x * z2;
				const yy = y * y2, yz = y * z2, zz = z * z2;
				const wx = w * x2, wy = w * y2, wz = w * z2;

				this._matrix[ 0 ] = 1 - ( yy + zz );
				this._matrix[ 1 ] = xy + wz;
				this._matrix[ 2 ] = xz - wy;
				this._matrix[ 3 ] = 0;
				this._matrix[ 4 ] = xy - wz;
				this._matrix[ 5 ] = 1 - ( xx + zz );
				this._matrix[ 6 ] = yz + wx;
				this._matrix[ 7 ] = 0;
				this._matrix[ 8 ] = xz + wy;
				this._matrix[ 9 ] = yz - wx;
				this._matrix[ 10 ] = 1 - ( xx + yy );
				this._matrix[ 11 ] = 0;
				this._matrix[ 12 ] = this.position.x;
				this._matrix[ 13 ] = this.position.y;
				this._matrix[ 14 ] = this.position.z;
				this._matrix[ 15 ] = 1;

			}

			return this._matrix;

		}

		get inverse() {

			const invQ = new DOMPointReadOnly( - this.orientation.x, - this.orientation.y, - this.orientation.z, this.orientation.w );
			const p = this.position;
			const qx = invQ.x, qy = invQ.y, qz = invQ.z, qw = invQ.w;

			const ix = qw * - p.x + qy * - p.z - qz * - p.y;
			const iy = qw * - p.y + qz * - p.x - qx * - p.z;
			const iz = qw * - p.z + qx * - p.y - qy * - p.x;
			const iw = - qx * - p.x - qy * - p.y - qz * - p.z;

			const invP = new DOMPointReadOnly(
				ix * qw + iw * qx + iy * qz - iz * qy,
				iy * qw + iw * qy + iz * qx - ix * qz,
				iz * qw + iw * qz + ix * qy - iy * qx,
				1
			);

			return new XRRigidTransform( invP, invQ );

		}

	}

	class XRInputSourcesChangeEvent extends Event {

		constructor( type, init ) {

			super( type );
			this.session = init.session;
			this.added = init.added || [];
			this.removed = init.removed || [];

		}

	}

	class XRInputSourceArray extends Array {

		constructor() {

			super();
			this._handTrackingEnabled = false;
			this._leftHand = null;
			this._rightHand = null;
			this._leftHandActive = false;
			this._rightHandActive = false;
			this._session = null;

		}

		_update( leftData, rightData ) {

			const added = [];
			const removed = [];

			// Handle left hand
			const leftVisible = leftData && leftData.visible;

			if ( leftVisible && ! this._leftHandActive ) {

				// Left hand appeared
				if ( ! this._leftHand ) {

					this._leftHand = new XRInputSource( 'left', leftData, this._handTrackingEnabled, this._session );

				} else {

					this._leftHand._updateHand( leftData );

				}

				this._leftHandActive = true;
				added.push( this._leftHand );

			} else if ( ! leftVisible && this._leftHandActive ) {

				// Left hand disappeared
				if ( ! this._handTrackingEnabled && this._leftHand._isPinching ) {

					this._leftHand._isPinching = false;
					this._session.dispatchEvent( new XRSelectEvent( 'selectend', { inputSource: this._leftHand, session: this._session, frame: this._session._currentFrame } ) );

				}

				this._leftHandActive = false;
				removed.push( this._leftHand );

			} else if ( leftVisible && this._leftHand ) {

				// Update existing hand
				this._leftHand._updateHand( leftData );

			}

			// Handle right hand
			const rightVisible = rightData && rightData.visible;

			if ( rightVisible && ! this._rightHandActive ) {

				// Right hand appeared
				if ( ! this._rightHand ) {

					this._rightHand = new XRInputSource( 'right', rightData, this._handTrackingEnabled, this._session );

				} else {

					this._rightHand._updateHand( rightData );

				}

				this._rightHandActive = true;
				added.push( this._rightHand );

			} else if ( ! rightVisible && this._rightHandActive ) {

				// Right hand disappeared
				if ( ! this._handTrackingEnabled && this._rightHand._isPinching ) {

					this._rightHand._isPinching = false;
					this._session.dispatchEvent( new XRSelectEvent( 'selectend', { inputSource: this._rightHand, session: this._session, frame: this._session._currentFrame } ) );

				}

				this._rightHandActive = false;
				removed.push( this._rightHand );

			} else if ( rightVisible && this._rightHand ) {

				// Update existing hand
				this._rightHand._updateHand( rightData );

			}

			// Update the array contents
			this.length = 0;
			if ( this._leftHandActive ) this.push( this._leftHand );
			if ( this._rightHandActive ) this.push( this._rightHand );

			// Dispatch inputsourceschange event if hands changed
			if ( ( added.length > 0 || removed.length > 0 ) && this._session ) {

				const event = new XRInputSourcesChangeEvent( 'inputsourceschange', {
					session: this._session,
					added: added,
					removed: removed
				} );
				this._session.dispatchEvent( event );

			}

		}

	}

	class XRInputSource {

		constructor( handedness, handData, handTrackingEnabled = false, session = null ) {

			this.handedness = handedness;
			this.targetRayMode = 'tracked-pointer';
			this.targetRaySpace = new XRSpace();
			this.gripSpace = new XRSpace();

			// Create a gamepad-like object for compatibility with apps that expect it
			this.gamepad = {
				axes: [ 0, 0, 0, 0 ],
				buttons: [
					{ pressed: false, touched: false, value: 0 }, // trigger
					{ pressed: false, touched: false, value: 0 }, // grip
					{ pressed: false, touched: false, value: 0 }, // touchpad
					{ pressed: false, touched: false, value: 0 }, // thumbstick
				],
				connected: true,
				hand: handedness,
				hapticActuators: [],
				id: 'webxr-webcam-emulator',
				index: handedness === 'left' ? 0 : 1,
				mapping: 'xr-standard',
				timestamp: performance.now()
			};

			if ( handTrackingEnabled ) {

				this.profiles = [ 'generic-hand', 'generic-hand-select' ];
				this.hand = new XRHand( handData );

			} else {

				this.profiles = [ 'generic-trigger', 'generic-touchpad' ];

				this._pinchThreshold = 0.05;
				this._isPinching = false;

			}

			this._handTrackingEnabled = handTrackingEnabled;
			this._session = session;
			this._updateHand( handData );

		}

		get session() {

			return this._session;

		}

		_updateHand( handData ) {

			if ( this._handTrackingEnabled && this.hand ) {

				this.hand._update( handData );

			}

			if ( handData && handData.joints[ 0 ] ) {

				const wrist = handData.joints[ 0 ];
				this.gripSpace._transform = new XRRigidTransform(
					new DOMPointReadOnly( wrist.position.x, wrist.position.y, wrist.position.z, 1 ),
					new DOMPointReadOnly( 0, 0, 0, 1 )
				);
				this.targetRaySpace._transform = this.gripSpace._transform;

				this._updateGamepad( handData );

				if ( ! this._handTrackingEnabled && this._session ) {

					this._detectGestures( handData );

				}

			}

		}

		_updateGamepad( handData ) {

			const joints = handData.joints;
			if ( joints.length < 10 ) return;

			const thumbTip = joints[ 4 ].position;
			const indexTip = joints[ 9 ].position;

			const pinchDist = Math.sqrt(
				( thumbTip.x - indexTip.x ) ** 2 +
				( thumbTip.y - indexTip.y ) ** 2 +
				( thumbTip.z - indexTip.z ) ** 2
			);

			const pinchThreshold = this._pinchThreshold || 0.05;
			const triggerValue = Math.max( 0, 1 - ( pinchDist / pinchThreshold ) );

			this.gamepad.buttons[ 0 ].pressed = pinchDist < pinchThreshold;
			this.gamepad.buttons[ 0 ].touched = pinchDist < pinchThreshold * 2;
			this.gamepad.buttons[ 0 ].value = Math.min( 1, triggerValue );
			this.gamepad.timestamp = performance.now();

		}

		_detectGestures( handData ) {

			const joints = handData.joints;
			if ( joints.length < 10 ) return;

			const thumbTip = joints[ 4 ].position;
			const indexTip = joints[ 9 ].position;

			const pinchDist = Math.sqrt(
				( thumbTip.x - indexTip.x ) ** 2 +
				( thumbTip.y - indexTip.y ) ** 2 +
				( thumbTip.z - indexTip.z ) ** 2
			);

			const isPinching = pinchDist < this._pinchThreshold;

			if ( isPinching && ! this._isPinching ) {

				this._isPinching = true;
				this._session.dispatchEvent( new XRSelectEvent( 'selectstart', { inputSource: this, session: this._session, frame: this._session._currentFrame } ) );

			} else if ( ! isPinching && this._isPinching ) {

				this._isPinching = false;
				this._session.dispatchEvent( new XRSelectEvent( 'selectend', { inputSource: this, session: this._session, frame: this._session._currentFrame } ) );

			}

		}

	}

	class XRHand extends Map {

		constructor( handData ) {

			super();

			for ( let i = 0; i < HAND_JOINTS.length; i ++ ) {

				this.set( HAND_JOINTS[ i ], new XRJointSpace( HAND_JOINTS[ i ], { joints: [] }, i ) );

			}

			this._handData = handData;

		}

		_update( handData ) {

			this._handData = handData;

			for ( let i = 0; i < HAND_JOINTS.length; i ++ ) {

				this.get( HAND_JOINTS[ i ] )._handData = handData || { joints: [] };

			}

		}

		get size() { return HAND_JOINTS.length; }

	}

	class XRWebGLLayer {

		constructor( session, context, options = {} ) {

			this._session = session;
			this._context = context;
			this._antialias = options.antialias !== false;
			this._ignoreDepthValues = options.ignoreDepthValues === true;
			this._framebuffer = null;
			this._framebufferWidth = context.canvas.width || 1920;
			this._framebufferHeight = context.canvas.height || 1080;

		}

		get antialias() { return this._antialias; }
		get ignoreDepthValues() { return this._ignoreDepthValues; }
		get framebuffer() { return this._framebuffer; }
		get framebufferWidth() { return this._framebufferWidth; }
		get framebufferHeight() { return this._framebufferHeight; }

		getViewport( view ) {

			if ( view.eye === 'none' ) {

				// Mono mode - use full framebuffer
				return { x: 0, y: 0, width: this._framebufferWidth, height: this._framebufferHeight };

			}

			// Stereo mode - split viewport left/right
			const halfWidth = this._framebufferWidth / 2;
			return view.eye === 'left'
				? { x: 0, y: 0, width: halfWidth, height: this._framebufferHeight }
				: { x: halfWidth, y: 0, width: halfWidth, height: this._framebufferHeight };

		}

		static getNativeFramebufferScaleFactor( session ) { return 1.0; }

	}

	class XRWebGLBinding {

		constructor( session, context ) {

			this._session = session;
			this._context = context;
			this._cameraTexture = null;

		}

		getCameraImage( camera ) {

			if ( ! camera || ! videoElement ) return null;

			const gl = this._context;

			// Create or update the camera texture from the video element
			if ( ! this._cameraTexture ) {

				this._cameraTexture = gl.createTexture();

			}

			gl.bindTexture( gl.TEXTURE_2D, this._cameraTexture );
			gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement );
			gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR );
			gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR );
			gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE );
			gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE );
			gl.bindTexture( gl.TEXTURE_2D, null );

			return this._cameraTexture;

		}

		getViewSubImage( layer, view ) {

			const viewport = layer.getViewport( view );

			return {
				colorTexture: layer.framebuffer,
				depthStencilTexture: null,
				imageIndex: 0,
				viewport: viewport
			};

		}

	}

	// --------------------------------------------------
	// Install Polyfill
	// --------------------------------------------------

	// Remove native WebXR
	try { delete Navigator.prototype.xr; } catch ( e ) {}

	const xrSystem = new XRSystem();

	Object.defineProperty( navigator, 'xr', {
		value: xrSystem,
		writable: false,
		configurable: true
	} );

	// Polyfill makeXRCompatible on WebGL contexts - just resolve immediately
	function patchMakeXRCompatible( prototype ) {

		prototype.makeXRCompatible = function () {

			return Promise.resolve();

		};

	}

	if ( typeof WebGLRenderingContext !== 'undefined' ) {

		patchMakeXRCompatible( WebGLRenderingContext.prototype );

	}

	if ( typeof WebGL2RenderingContext !== 'undefined' ) {

		patchMakeXRCompatible( WebGL2RenderingContext.prototype );

	}

	// Global XR classes
	window.XRWebGLLayer = XRWebGLLayer;
	window.XRWebGLBinding = XRWebGLBinding;
	window.XRSession = XRSession;
	window.XRFrame = XRFrame;
	window.XRView = XRView;
	window.XRCamera = XRCamera;
	window.XRViewerPose = XRViewerPose;
	window.XRReferenceSpace = XRReferenceSpace;
	window.XRRigidTransform = XRRigidTransform;
	window.XRInputSource = XRInputSource;
	window.XRInputSourceArray = XRInputSourceArray;
	window.XRHand = XRHand;
	window.XRSpace = XRSpace;
	window.XRJointSpace = XRJointSpace;
	window.XRPose = XRPose;
	window.XRJointPose = XRJointPose;
	window.XRSessionEvent = XRSessionEvent;
	window.XRInputSourcesChangeEvent = XRInputSourcesChangeEvent;
	window.XRSelectEvent = XRSelectEvent;

	console.log( '[WebXR Webcam Emulator] Polyfill installed' );

} )();
