package app

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"gopkg.in/yaml.v3"
)

func TestComposeHostNetworkKeepsHTTPPrivateAndDisablesLegacyUDP(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("..", "..", "..", "deploy", "compose", "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var configuration struct {
		Services map[string]struct {
			NetworkMode string            `yaml:"network_mode"`
			Ports       []string          `yaml:"ports"`
			Environment map[string]string `yaml:"environment"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(content, &configuration); err != nil {
		t.Fatal(err)
	}
	service, exists := configuration.Services["intercom"]
	if !exists || service.NetworkMode != "host" || len(service.Ports) != 0 {
		t.Fatal("WebRTC must use Linux host networking without Docker bridge port mappings")
	}
	if service.Environment["APP_ADDR"] != "127.0.0.1:8080" {
		t.Fatal("host-network HTTP backend must bind explicitly to loopback")
	}
	if value, exists := service.Environment["UDP_AUDIO_ADDR"]; !exists || value != "" {
		t.Fatal("legacy unencrypted UDP relay must be explicitly disabled")
	}
}

func TestWebRTCTransportNegotiatesDTLSAndReceivesSRTP(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	serverAPI, err := buildWebRTCAPI(logger)
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := serverAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sender.Close() })
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "security-test", "fixture")
	if err != nil {
		t.Fatal(err)
	}
	rtpSender, err := sender.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 1)
	receiver.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, err := remote.ReadRTP()
		if err == nil {
			received <- append([]byte(nil), packet.Payload...)
		}
	})
	connected := make(chan struct{}, 1)
	sender.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	offerGathered := webrtc.GatheringCompletePromise(sender)
	if err := sender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-offerGathered:
	case <-time.After(5 * time.Second):
		t.Fatal("sender ICE candidate gathering did not finish")
	}
	if err := receiver.SetRemoteDescription(*sender.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerGathered := webrtc.GatheringCompletePromise(receiver)
	if err := receiver.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-answerGathered:
	case <-time.After(5 * time.Second):
		t.Fatal("receiver ICE candidate gathering did not finish")
	}
	sessionDescription := receiver.LocalDescription()
	for _, required := range []string{"a=fingerprint:sha-256", "UDP/TLS/RTP/SAVPF", "a=candidate:"} {
		if !strings.Contains(sessionDescription.SDP, required) {
			t.Fatalf("missing secure transport property %s", required)
		}
	}
	if err := sender.SetRemoteDescription(*sessionDescription); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatal("WebRTC ICE/DTLS connection did not establish")
	}
	if rtpSender.Transport().State() != webrtc.DTLSTransportStateConnected {
		t.Fatal("media transport has no completed DTLS handshake")
	}
	payload := []byte{0xf8, 0xff, 0xfe}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	sequence := uint16(0)
	for {
		select {
		case data := <-received:
			if !bytes.Equal(data, payload) {
				t.Fatal("received media payload differs")
			}
			return
		case <-ticker.C:
			sequence++
			if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 960, SSRC: 12345, PayloadType: 111}, Payload: payload}); err != nil {
				t.Fatal(err)
			}
		case <-deadline.C:
			t.Fatal("no decrypted SRTP fixture received")
		}
	}
}
